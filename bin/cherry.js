#! /usr/bin/env node

import axios from 'axios'
import { program } from 'commander'
import dotenv from 'dotenv'
import fs from 'fs'
import _ from 'lodash'
import prompt from 'prompt'
import Spinnies from 'spinnies'
import { v4 as uuidv4 } from 'uuid'
import packageJson from '../package.json' assert { type: 'json' }
import Codeowners from '../src/codeowners.js'
import {
  createConfigurationFile,
  createWorkflowFile,
  getConfiguration,
  getConfigurationFile,
  workflowExists,
} from '../src/configuration.js'
import { computeContributions } from '../src/contributions.js'
import { substractDays, toISODate } from '../src/date.js'
import { panic } from '../src/error.js'
import { getFiles } from '../src/files.js'
import * as git from '../src/git.js'
import { buildRepoURL } from '../src/github.js'
import { setVerboseMode } from '../src/log.js'
import { findOccurrences } from '../src/occurences.js'

dotenv.config()

const spinnies = new Spinnies()

const API_BASE_URL = process.env.API_URL ?? 'https://www.cherrypush.com/api'
const UPLOAD_BATCH_SIZE = 1000

program.command('init').action(async () => {
  const configurationFile = getConfigurationFile()
  if (configurationFile) {
    console.error(`${configurationFile} already exists.`)
    process.exit(0)
  }

  prompt.message = ''
  prompt.start()

  let projectName = await git.guessProjectName()
  if (!projectName) {
    projectName = await prompt.get({
      properties: { repo: { message: 'Enter your project name', required: true } },
    }).repo
  }
  createConfigurationFile(projectName)

  if (!workflowExists()) createWorkflowFile()
  console.log('Your initial setup is done! Now try the command `cherry run` to see your first metrics.')
})

program
  .command('run')
  .option('--owner <owner>', 'only consider given owner code')
  .option('--metric <metric>', 'only consider given metric')
  .option('-o, --output <output>', 'export stats into a local file')
  .option('-f, --format <format>', 'export format (json, sarif, sonar). default: json')
  .action(async (options) => {
    const configuration = await getConfiguration()
    const codeOwners = new Codeowners()
    const owners = options.owners ? options.owners.split(',') : null
    const files = options.owner ? await getFiles(options.owner.split(','), codeOwners) : await getFiles()

    const occurrences = await findOccurrences({ configuration, files, metric: options.metric, codeOwners })
    if (options.owner || options.metric) {
      let displayedOccurrences = occurrences
      if (owners) displayedOccurrences = displayedOccurrences.filter((o) => _.intersection(o.owners, owners).length)
      if (options.metric) displayedOccurrences = displayedOccurrences.filter((o) => o.metricName === options.metric)

      displayedOccurrences.forEach((occurrence) => console.log(`👉 ${occurrence.text}`))
      console.log('Total occurrences:', displayedOccurrences.length)
    } else console.table(sortObject(countByMetric(occurrences)))

    if (options.output) {
      const filepath = process.cwd() + '/' + options.output
      const format = options.format || 'json'
      let content

      if (format === 'json') {
        const metrics = buildMetricsPayload(occurrences)
        content = JSON.stringify(metrics, null, 2)
      } else if (format === 'sarif') {
        const branch = await git.branchName()
        const sha = await git.sha()
        const sarif = buildSarifPayload(configuration.project_name, branch, sha, occurrences)
        content = JSON.stringify(sarif, null, 2)
      } else if (format === 'sonar') {
        const sonar = buildSonarGenericImportPayload(occurrences)
        content = JSON.stringify(sonar, null, 2)
      }
      fs.writeFile(filepath, content, 'utf8', function (err) {
        if (err) panic(err)
        console.log(`File has been saved as ${filepath}`)
      })
    }
  })

program
  .command('push')
  .option('--api-key <api_key>', 'Your cherrypush.com api key')
  .action(async (options) => {
    const configuration = await getConfiguration()
    const initialBranch = await git.branchName()
    if (!initialBranch) panic('Not on a branch, checkout a branch before pushing metrics.')
    const sha = await git.sha()

    const apiKey = options.apiKey || process.env.CHERRY_API_KEY
    if (!apiKey) panic('Please provide an API key with --api-key or CHERRY_API_KEY environment variable')

    let error
    try {
      console.log('Computing metrics for current commit...')
      const occurrences = await findOccurrences({
        configuration,
        files: await getFiles(),
        codeOwners: new Codeowners(),
      })

      await upload(apiKey, configuration.project_name, await git.commitDate(sha), occurrences)

      console.log('')
      console.log('Computing metrics for previous commit...')
      await git.checkout(`${sha}~`)
      const previousOccurrences = await findOccurrences({
        configuration,
        files: await getFiles(),
        codeOwners: new Codeowners(),
      })

      const contributions = computeContributions(occurrences, previousOccurrences)

      if (contributions.length) {
        console.log(`  Uploading contributions...`)
        await uploadContributions(
          apiKey,
          configuration.project_name,
          await git.authorName(sha),
          await git.authorEmail(sha),
          sha,
          await git.commitDate(sha),
          contributions
        )
      } else console.log('No contribution found, skipping')
    } catch (exception) {
      error = exception
    } finally {
      git.checkout(initialBranch)
    }
    if (error) {
      console.error(error)
      process.exit(1)
    }

    console.log(`Your dashboard is available at https://www.cherrypush.com/user/projects`)
  })

program
  .command('diff')
  .requiredOption('--metric <metric>')
  .option('--api-key <api_key>', 'Your cherrypush.com API key (available on https://www.cherrypush.com/user/settings)')
  .option('--error-if-increase', 'Return an error status code (1) if the metric increased since its last report')
  .action(async (options) => {
    const configuration = await getConfiguration()
    const apiKey = options.apiKey || process.env.CHERRY_API_KEY
    const metric = options.metric

    let lastMetricValue
    let previousOccurrences
    try {
      const params = { project_name: configuration.project_name, metric_name: metric, api_key: apiKey }
      const response = await axios.get(API_BASE_URL + '/metrics', { params })
      lastMetricValue = response.data.value
      previousOccurrences = response.data.occurrences
      if (!Number.isInteger(lastMetricValue)) {
        console.log('No last value found for this metric, aborting.')
        process.exit(0)
      }
      console.log(`Last metric value: ${lastMetricValue}`)
    } catch (e) {
      console.error(e)
      process.exit(0)
    }

    const occurrences = await findOccurrences({
      configuration,
      files: await getFiles(),
      codeOwners: new Codeowners(),
      metric,
    })

    const currentMetricValue = countByMetric(occurrences)[metric] || 0
    console.log(`Current metric value: ${currentMetricValue}`)

    const diff = currentMetricValue - lastMetricValue
    console.log(`Difference: ${diff}`)

    if (diff > 0) {
      console.log('Added occurrences:')
      const newOccurrencesTexts = occurrences.filter((o) => o.metricName === metric).map((o) => o.text)
      console.log(newOccurrencesTexts.filter((x) => !previousOccurrences.includes(x)))
    }

    if (diff > 0 && options.errorIfIncrease) process.exit(1)
  })

program
  .command('backfill')
  .option('--api-key <api_key>', 'Your cherrypush.com api key')
  .option('--since <since>', 'yyyy-mm-dd | The date at which the backfill will start (defaults to 90 days ago)')
  .option('--until <until>', 'yyyy-mm-dd | The date at which the backfill will stop (defaults to today)')
  .option('--interval <interval>', 'The number of days between backfills (defaults to 30 days)')
  .action(async (options) => {
    const since = options.since ? new Date(options.since) : substractDays(new Date(), 90)
    const until = options.until ? new Date(options.until) : new Date()
    const interval = options.interval ? parseInt(options.interval) : 30
    if (isNaN(since)) panic('Invalid since date')
    if (isNaN(until)) panic('Invalid until date')
    if (since > until) panic('The since date must be before the until date')
    const initialBranch = await git.branchName()
    if (!initialBranch) panic('Not on a branch, checkout a branch before running the backfill.')
    const hasUncommitedChanges = (await git.uncommittedFiles()).length > 0
    if (hasUncommitedChanges) panic('Please commit your changes before running this command')

    const configuration = await getConfiguration()
    const apiKey = options.apiKey || process.env.CHERRY_API_KEY
    if (!apiKey) panic('Please provide an API key with --api-key or CHERRY_API_KEY environment variable')

    let date = until
    let sha = await git.sha()
    try {
      while (date >= since) {
        const committedAt = await git.commitDate(sha)
        console.log(`On day ${toISODate(date)}...`)

        await git.checkout(sha)

        const files = await getFiles()
        const codeOwners = new Codeowners()
        const occurrences = await findOccurrences({ configuration, files, codeOwners })
        await upload(apiKey, configuration.project_name, committedAt, occurrences)

        date = substractDays(committedAt, interval)
        sha = await git.commitShaAt(date, initialBranch)
        if (!sha) {
          console.log(`no commit found after ${toISODate(date)}, ending backfill`)
          break
        }
        if (committedAt > until || committedAt < since) break
      }
    } catch (error) {
      console.error(error)
      await git.checkout(initialBranch)
      process.exit(1)
    }

    await git.checkout(initialBranch)
    console.log(`Your dashboard is available at ${API_BASE_URL}/user/projects`)
  })

const handleApiError = async (callback) => {
  try {
    return await callback()
  } catch (error) {
    if (error.response)
      throw new Error(
        `❌ Error while calling cherrypush.com API ${error.response.status}: ${
          error.response.data?.error || error.response.statusText
        }`
      )
    throw error
  }
}

const upload = async (apiKey, projectName, date, occurrences) => {
  if (!projectName) panic('specify a project_name in your cherry.js configuration file before pushing metrics')

  const uuid = await uuidv4()
  const occurrencesBatches = _.chunk(occurrences, UPLOAD_BATCH_SIZE)

  console.log('')
  console.log(`Uploading ${occurrences.length} occurrences in ${occurrencesBatches.length} batches:`)
  for (const [index, occurrencesBatch] of occurrencesBatches.entries()) {
    spinnies.add('batches', { text: `Batch ${index + 1} out of ${occurrencesBatches.length}`, indent: 2 })

    try {
      await handleApiError(() =>
        axios
          .post(
            API_BASE_URL + '/push',
            buildPushPayload({ apiKey, projectName, uuid, date, occurrences: occurrencesBatch })
          )
          .then(({ data }) => data)
          .then(() => spinnies.succeed('batches', { text: `Batch ${index + 1} out of ${occurrencesBatches.length}` }))
      )
    } catch (error) {
      spinnies.fail('batches', {
        text: `Batch ${index + 1} out of ${occurrencesBatches.length}: ${error.message}`,
      })
    }
  }
}

const buildMetricsPayload = (occurrences) =>
  _(occurrences)
    .groupBy('metricName')
    .mapValues((occurrences, metricName) => ({
      name: metricName,
      occurrences: occurrences.map((o) => _.pick(o, 'text', 'value', 'url', 'owners')),
    }))
    .values()
    .flatten()
    .value()

const buildSarifPayload = (projectName, branch, sha, occurrences) => {
  const rules = _(occurrences)
    .groupBy('metricName')
    .map((occurrences) => ({
      id: occurrences[0].metricName,
    }))

  const results = occurrences.map((occurrence) => ({
    ruleId: occurrence.metricName,
    level: 'none',
    message: { text: `${occurrence.metricName} at ${occurrence.text}` },
    locations: [
      {
        physicalLocation: {
          artifactLocation: {
            uri: occurrence.text.split(':')[0],
          },
          region: {
            startLine: parseInt(occurrence.text.split(':')[1]) || 1,
          },
        },
      },
    ],
  }))

  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        versionControlProvenance: [
          {
            repositoryUri: buildRepoURL(projectName),
            revisionId: sha,
            branch,
          },
        ],
        tool: {
          driver: {
            name: 'cherry',
            version: packageJson.version,
            informationUri: 'https://github.com/cherrypush/cherrypush.com',
            rules,
          },
        },
        results,
      },
    ],
  }
}

const buildSonarGenericImportPayload = (occurrences) => ({
  issues: occurrences.map((occurrence) => ({
    engineId: 'cherry',
    ruleId: occurrence.metricName,
    type: 'CODE_SMELL',
    severity: 'INFO',
    primaryLocation: {
      message: `${occurrence.metricName} at ${occurrence.text}`,
      filePath: occurrence.text.split(':')[0],
      textRange: {
        startLine: parseInt(occurrence.text.split(':')[1]) || 1,
      },
    },
  })),
})

const buildPushPayload = ({ apiKey, projectName, uuid, date, occurrences }) => ({
  api_key: apiKey,
  project_name: projectName,
  date: date.toISOString(),
  uuid,
  metrics: buildMetricsPayload(occurrences),
})

const uploadContributions = async (apiKey, projectName, authorName, authorEmail, sha, date, contributions) =>
  handleApiError(() =>
    axios
      .post(
        API_BASE_URL + '/contributions',
        buildContributionsPayload(projectName, authorName, authorEmail, sha, date, contributions),
        { params: { api_key: apiKey } }
      )
      .then(({ data }) => data)
  )

const buildContributionsPayload = (projectName, authorName, authorEmail, sha, date, contributions) => ({
  project_name: projectName,
  author_name: authorName,
  author_email: authorEmail,
  commit_sha: sha,
  commit_date: date.toISOString(),
  contributions: contributions.map((contribution) => ({
    metric_name: contribution.metricName,
    diff: contribution.diff,
  })),
})

const sortObject = (object) => _(object).toPairs().sortBy(0).fromPairs().value()

// This function must process values the same way as api/pushes#create endpoint
const countByMetric = (occurrences) =>
  _(occurrences)
    .groupBy('metricName')
    .mapValues((occurrences) =>
      _.sumBy(occurrences, (occurrence) => (_.isNumber(occurrence.value) ? occurrence.value : 1))
    )
    .value()

program
  .option('-v, --verbose', 'Enable verbose mode')
  .hook('preAction', (thisCommand) => {
    if (thisCommand.opts().verbose) setVerboseMode(true)
  })
  .parse(process.argv)

#!/usr/bin/env node
// Fails when a PR changes `src/` and none of the docs changes. The `sem-doc` label waives it
// (env SEM_DOC_LABEL=true). Input: the changed files, one per line, on stdin.
'use strict'

const DOC_PATHS = ['README.md', 'PUBLISHING.md', 'specs/', 'docs/']

let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => (input += chunk))
process.stdin.on('end', () => {
  const files = input.split(/\r?\n/).map((f) => f.trim()).filter(Boolean)
  const srcChanged = files.some((f) => f.startsWith('src/'))
  const docChanged = files.some((f) => DOC_PATHS.some((p) => (p.endsWith('/') ? f.startsWith(p) : f === p)))
  if (!srcChanged || docChanged) {
    console.log('Doc check ok.')
  } else if (process.env.SEM_DOC_LABEL === 'true') {
    console.log('src/ changed without docs; waived by the sem-doc label.')
  } else {
    console.error(
      `src/ changed and none of ${DOC_PATHS.join(', ')} changed.\n` +
        'Update the docs (see the PR template checklist) or add the `sem-doc` label.'
    )
    process.exitCode = 1
  }
})

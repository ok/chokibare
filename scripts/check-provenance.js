// chokibare original: lint step — every runtime source file states where it came from.
'use strict'

const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const DERIVED =
  /^\/\/ Derived from chokidar src\/[a-z0-9.-]+ @ [0-9a-f]{7} \(https:\/\/github\.com\/paulmillr\/chokidar, branch v6\)\.$/m
const ORIGINAL = /^\/\/ chokibare original: .+$/m

function sources() {
  const files = [path.join(root, 'index.js')]
  const lib = path.join(root, 'lib')
  if (fs.existsSync(lib)) {
    for (const name of fs.readdirSync(lib)) {
      if (name.endsWith('.js')) files.push(path.join(lib, name))
    }
  }
  return files.filter((f) => fs.existsSync(f))
}

let failed = false
for (const file of sources()) {
  const head = fs.readFileSync(file, 'utf8').split('\n').slice(0, 3).join('\n')
  if (DERIVED.test(head) || ORIGINAL.test(head)) continue
  failed = true
  console.error(`missing provenance header: ${path.relative(root, file)}`)
}

if (failed) {
  console.error(
    'Every file under lib/ and index.js must start with either\n' +
      '  // Derived from chokidar src/<file> @ 74adf65 (https://github.com/paulmillr/chokidar, branch v6).\n' +
      '  // MIT License. Copyright (c) 2012 Paul Miller (https://paulmillr.com), Elan Shanker.\n' +
      'or\n' +
      '  // chokibare original: <one line saying what it is>'
  )
  process.exit(1)
}

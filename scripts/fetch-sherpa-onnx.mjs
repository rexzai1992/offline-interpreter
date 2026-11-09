#!/usr/bin/env node
/**
 * Fetches the official sherpa-onnx Android library used by modules/sensevoice and
 * extracts only what the app needs (the Kotlin API classes and the two arm64
 * native libraries). The download is verified against a pinned SHA-256.
 * Runs from `postinstall`; safe to re-run (skips work when files are present).
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

const VERSION = '2.0.1'
const URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/v${VERSION}/sherpa-onnx-${VERSION}.aar`
const SHA256 = 'a8d09d1d32f3eb8520482c6d3d43fae674681c5b050385967c70a3c2c9bf0ee7'
const ABIS = ['arm64-v8a']
const LIBS = ['libsherpa-onnx-jni.so', 'libonnxruntime.so']

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const android = join(root, 'modules', 'sensevoice', 'android')
const jarOut = join(android, 'libs', `sherpa-onnx-${VERSION}.jar`)
const soOut = (abi, lib) => join(android, 'src', 'main', 'jniLibs', abi, lib)

const wanted = [jarOut, ...ABIS.flatMap((abi) => LIBS.map((lib) => soOut(abi, lib)))]
if (wanted.every((p) => existsSync(p))) {
  console.log(`[sherpa-onnx] ${VERSION} already present`)
  process.exit(0)
}

const work = mkdtempSync(join(tmpdir(), 'sherpa-onnx-'))
try {
  const aar = join(work, 'sherpa-onnx.aar')
  console.log(`[sherpa-onnx] downloading ${URL}`)
  const res = await fetch(URL)
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`)
  await pipeline(Readable.fromWeb(res.body), createWriteStream(aar))
  const digest = createHash('sha256').update(readFileSync(aar)).digest('hex')
  if (digest !== SHA256) throw new Error(`checksum mismatch: got ${digest}, expected ${SHA256}`)
  const out = join(work, 'x')
  mkdirSync(out)
  const members = ['classes.jar', ...ABIS.flatMap((abi) => LIBS.map((lib) => `jni/${abi}/${lib}`))]
  execFileSync('unzip', ['-q', '-o', aar, ...members, '-d', out], { stdio: 'inherit' })
  mkdirSync(dirname(jarOut), { recursive: true })
  copyFileSync(join(out, 'classes.jar'), jarOut)
  for (const abi of ABIS) {
    for (const lib of LIBS) {
      const dest = soOut(abi, lib)
      mkdirSync(dirname(dest), { recursive: true })
      renameSync(join(out, 'jni', abi, lib), dest)
    }
  }
  console.log(`[sherpa-onnx] ${VERSION} extracted into modules/sensevoice/android`)
} finally {
  rmSync(work, { recursive: true, force: true })
}

// engine/ is vendored file-for-file into the Chris-Centaur bot, so it may
// import only from itself and from the shared wire types. This test parses the
// real imports rather than trusting review: add a logger, a Firestore handle
// or a reach up into ../ and the build fails here, with the offending line.
//
// See engine/VENDOR.md for the file list and the rest of the contract.

import { readFileSync, readdirSync } from "fs"
import { join } from "path"

const ENGINE_DIR = join(__dirname, "engine")

/** The one module outside engine/ that engine/ files may depend on. */
const ALLOWED_EXTERNAL = ["@shared/types/Game"]

/** Every `from "..."` specifier in a source file, in order. */
const importsOf = (source: string): string[] =>
  Array.from(source.matchAll(/\bfrom\s+["']([^"']+)["']/g)).map((m) => m[1])

const engineFiles = readdirSync(ENGINE_DIR).filter((f) => f.endsWith(".ts"))

describe("engine/ is vendorable", () => {
  it("contains the files VENDOR.md promises", () => {
    expect(engineFiles.sort()).toEqual([
      "moveGrammar.ts",
      "resolveTurn.ts",
      "turnEngine.ts",
    ])
    expect(readdirSync(ENGINE_DIR)).toContain("VENDOR.md")
  })

  it.each(engineFiles)("%s imports nothing outside engine/ or the wire types", (file) => {
    const source = readFileSync(join(ENGINE_DIR, file), "utf8")
    importsOf(source).forEach((specifier) => {
      if (ALLOWED_EXTERNAL.includes(specifier)) return
      // Anything else must be a sibling in this very directory.
      expect(specifier).toMatch(/^\.\/[A-Za-z0-9_-]+$/)
      expect(engineFiles).toContain(`${specifier.slice(2)}.ts`)
    })
  })

  it.each(engineFiles)("%s pulls in no runtime dependency and no ambient state", (file) => {
    const source = readFileSync(join(ENGINE_DIR, file), "utf8")
    // require() would sidestep the import check above.
    expect(source).not.toMatch(/\brequire\s*\(/)
    // A pure function of its input: no clock, no RNG, no network.
    expect(source).not.toMatch(/Math\.random|Date\.now|new Date\(|fetch\(/)
  })
})

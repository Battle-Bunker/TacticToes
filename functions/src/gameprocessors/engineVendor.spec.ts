// engine/ is vendored file-for-file into the Chris-Centaur bot, so it may
// import only from itself and from the shared wire types. This test parses the
// real imports rather than trusting review: add a logger, a Firestore handle
// or a reach up into ../ and the build fails here, with the offending line.
//
// See engine/VENDOR.md for the file list and the rest of the contract.

import { execFileSync } from "child_process"
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

const ENGINE_DIR = join(__dirname, "engine")

/** The one module outside engine/ that engine/ files may depend on. */
const ALLOWED_EXTERNAL = ["@shared/types/Game"]

/** Every `from "..."` specifier in a source file, in order. */
const importsOf = (source: string): string[] =>
  Array.from(source.matchAll(/\bfrom\s+["']([^"']+)["']/g)).map((m) => m[1])

const engineFiles = readdirSync(ENGINE_DIR).filter((f) => f.endsWith(".ts"))

describe("engine/ is vendorable", () => {
  it("contains the files VENDOR.md promises, and nothing else", () => {
    expect(engineFiles.sort()).toEqual([
      "adjudicate.ts",
      "claims.ts",
      "moveGrammar.ts",
      "queries.ts",
      "resolveTurn.ts",
      "settlePartial.ts",
      "settleTurn.ts",
      "spawn.ts",
      "turnEngine.ts",
    ])
    // Exactly these, because vendoring copies the whole directory. Anything
    // else that lands here travels with it — a stale compiled .js beside its
    // .ts is the easy accident (running the VENDOR.md compile check without
    // --noEmit leaves three), and in the destination it can shadow the source
    // it was built from.
    expect(readdirSync(ENGINE_DIR).sort()).toEqual([
      "VENDOR.md",
      ...engineFiles.sort(),
    ])
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

// The contract's last clause, and the only one review cannot check: that the
// directory COMPILES on its own. Copied out, with no node_modules, no ambient
// types and nothing but the wire types beside it — which is the state it is in
// once it has been vendored. A stray `@types/node` reference or an import of a
// package that happens to be installed here passes every check above and
// fails only in the destination repo, weeks later.
describe("engine/ compiles standing alone", () => {
  it("type-checks with no node_modules and no ambient types", () => {
    const root = mkdtempSync(join(tmpdir(), "engine-vendor-"))
    try {
      mkdirSync(join(root, "engine"))
      mkdirSync(join(root, "shared", "types"), { recursive: true })
      engineFiles.forEach((file) =>
        writeFileSync(join(root, "engine", file), readFileSync(join(ENGINE_DIR, file))),
      )
      writeFileSync(
        join(root, "shared", "types", "Game.ts"),
        readFileSync(join(__dirname, "..", "..", "..", "shared", "types", "Game.ts")),
      )
      writeFileSync(
        join(root, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            module: "commonjs",
            target: "ES2020",
            strict: true,
            noImplicitReturns: true,
            noUnusedLocals: true,
            moduleResolution: "node",
            noEmit: true,
            types: [],
            baseUrl: ".",
            paths: { "@shared/*": ["shared/*"] },
          },
          include: ["engine", "shared"],
        }),
      )

      const tsc = join(__dirname, "..", "..", "node_modules", "typescript", "bin", "tsc")
      const output = execFileSync(process.execPath, [tsc, "--noEmit", "-p", root], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      })
      expect(output.trim()).toBe("")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 120000)
})

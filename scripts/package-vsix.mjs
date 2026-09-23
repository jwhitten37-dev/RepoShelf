import path from "node:path";
import { packageReleaseCandidate } from "./release-package.mjs";

const args = process.argv.slice(2);
let outputDirectory;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--out-dir") {
    outputDirectory = args[index + 1];
    index += 1;
  } else {
    throw new Error(`Unknown argument: ${args[index]}`);
  }
}
if (outputDirectory === undefined || outputDirectory.trim() === "") {
  throw new Error("Usage: npm run package:vsix -- --out-dir <directory>");
}

const result = await packageReleaseCandidate({
  outputDirectory: path.resolve(outputDirectory),
});
console.log(`Validated VSIX: ${result.vsixPath}`);
console.log(`Evidence: ${result.evidencePath}`);
console.log(`SHA-256: ${result.vsix.sha256}`);

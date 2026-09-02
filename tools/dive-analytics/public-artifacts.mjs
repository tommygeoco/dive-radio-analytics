// public-artifacts.mjs — one exact local assembly contract for every served
// human and agent file. Five files are derived from data.readout; two are
// static source files carried byte-for-byte. Static files are never described
// as generated.

export const GENERATED_PUBLIC_ARTIFACTS = Object.freeze([
  "data.json",
  "data.js",
  "agent.md",
  "agent.json",
  "llms.txt",
]);

export const STATIC_PUBLIC_ARTIFACTS = Object.freeze([
  "index.html",
  "agent-skill.md",
]);

export const PUBLIC_ARTIFACTS = Object.freeze([
  "index.html",
  "data.json",
  "data.js",
  "agent.md",
  "agent.json",
  "llms.txt",
  "agent-skill.md",
]);

export const PUBLIC_ARTIFACT_KIND = Object.freeze(Object.fromEntries([
  ...GENERATED_PUBLIC_ARTIFACTS.map((file) => [file, "generated"]),
  ...STATIC_PUBLIC_ARTIFACTS.map((file) => [file, "static-source"]),
]));

function assertExactFiles(group, expected, label) {
  if (!group || typeof group !== "object" || Array.isArray(group)) throw new Error(`${label} artifact map is missing`);
  const actual = Object.keys(group).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} artifact map must contain exactly ${wanted.join(", ")} (got ${actual.join(", ") || "none"})`);
  }
  for (const file of expected) {
    const value = group[file];
    if (!(typeof value === "string" || Buffer.isBuffer(value))) throw new Error(`${label} artifact ${file} is not exact text/bytes`);
  }
}

export function assemblePublicArtifacts({ generated, staticSources }) {
  assertExactFiles(generated, GENERATED_PUBLIC_ARTIFACTS, "generated");
  assertExactFiles(staticSources, STATIC_PUBLIC_ARTIFACTS, "static-source");
  return Object.fromEntries(PUBLIC_ARTIFACTS.map((file) => [
    file,
    PUBLIC_ARTIFACT_KIND[file] === "generated" ? generated[file] : staticSources[file],
  ]));
}

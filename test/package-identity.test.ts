import test from "node:test";
import assert from "node:assert/strict";
import type { FileManifest } from "../src/manifest.js";
import {
  canonicalizeResearchDeposit,
  createPublicationIdentity,
  PackageIdentityError,
  serializeCanonicalMetadata,
} from "../src/package-identity.js";

const manifest: FileManifest = {
  schemaVersion: "1",
  entries: [
    {
      sourcePath: "data/a.csv",
      depositPath: "data/a.csv",
      size: 3,
      sha256: "a".repeat(64),
      mediaType: "text/csv",
    },
    {
      sourcePath: "notes.md",
      depositPath: "docs/notes.md",
      size: 4,
      sha256: "b".repeat(64),
      mediaType: "text/markdown",
    },
  ],
};

function metadata() {
  return {
    resourceType: "dataset",
    title: "Cafe\u0301 dataset",
    description: "Behavioral data for package identity testing.",
    creators: [
      {
        orcid: "0000-0002-1825-0097",
        affiliation: "Institut E\u0301xample",
        name: "Huzard, Damien",
      },
      { name: "Doe, Jane" },
    ],
    keywords: ["zeta", "FAIR", "FAIR"],
    license: "cc-by-4.0",
    version: "1.0.0",
    publicationDate: "2026-09-14",
    relatedIdentifiers: [
      { relation: "isSupplementTo", identifier: "10.1/b" },
      { resourceType: "dataset", identifier: "10.1/a", relation: "isDerivedFrom" },
      { resourceType: "dataset", identifier: "10.1/a", relation: "isDerivedFrom" },
    ],
    notes: "",
  } as const;
}

const GOLDEN_METADATA = '{"creators":[{"affiliation":"Institut Éxample","name":"Huzard, Damien","orcid":"0000-0002-1825-0097"},{"name":"Doe, Jane"}],"description":"Behavioral data for package identity testing.","keywords":["FAIR","zeta"],"license":"cc-by-4.0","notes":"","publicationDate":"2026-09-14","relatedIdentifiers":[{"identifier":"10.1/a","relation":"isDerivedFrom","resourceType":"dataset"},{"identifier":"10.1/b","relation":"isSupplementTo"}],"resourceType":"dataset","schemaVersion":"1","title":"Café dataset","version":"1.0.0"}\n';

const GOLDEN_PACKAGE = '{"manifest":{"entries":[{"depositPath":"data/a.csv","mediaType":"text/csv","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","size":3,"sourcePath":"data/a.csv"},{"depositPath":"docs/notes.md","mediaType":"text/markdown","sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","size":4,"sourcePath":"notes.md"}],"schemaVersion":"1"},"metadata":{"creators":[{"affiliation":"Institut Éxample","name":"Huzard, Damien","orcid":"0000-0002-1825-0097"},{"name":"Doe, Jane"}],"description":"Behavioral data for package identity testing.","keywords":["FAIR","zeta"],"license":"cc-by-4.0","notes":"","publicationDate":"2026-09-14","relatedIdentifiers":[{"identifier":"10.1/a","relation":"isDerivedFrom","resourceType":"dataset"},{"identifier":"10.1/b","relation":"isSupplementTo"}],"resourceType":"dataset","schemaVersion":"1","title":"Café dataset","version":"1.0.0"},"schemaVersion":"1"}\n';

const GOLDEN_DIGEST = "sha256:5c3e2cdaf80417a59bba3b209b1f80cfb94a51f5b79277821ab6d41bbfa06092";

test("golden canonical metadata and package digest are stable", () => {
  const canonical = canonicalizeResearchDeposit(metadata());
  assert.equal(serializeCanonicalMetadata(canonical.metadata), GOLDEN_METADATA);

  const identity = createPublicationIdentity(metadata(), manifest);
  assert.equal(identity.canonical, GOLDEN_PACKAGE);
  assert.equal(identity.digest, GOLDEN_DIGEST);
});

test("object insertion order and unknown operational fields do not affect identity", () => {
  const one = createPublicationIdentity({ ...metadata(), localAbsolutePath: "/machine/a/project" }, manifest);
  const m = metadata();
  const reordered = {
    notes: m.notes,
    relatedIdentifiers: m.relatedIdentifiers,
    publicationDate: m.publicationDate,
    version: m.version,
    license: m.license,
    keywords: m.keywords,
    creators: m.creators,
    description: m.description,
    title: m.title,
    resourceType: m.resourceType,
    localAbsolutePath: "/different/machine/project",
  };
  const two = createPublicationIdentity(reordered, manifest);
  assert.equal(one.digest, two.digest);
  assert.equal(one.canonical, two.canonical);
});

test("scientifically relevant metadata mutation changes the digest", () => {
  const baseline = createPublicationIdentity(metadata(), manifest).digest;
  const changed = createPublicationIdentity({ ...metadata(), description: "Different scientific description." }, manifest).digest;
  assert.notEqual(baseline, changed);
});

test("creator order is preserved and affects the digest", () => {
  const m = metadata();
  const baseline = createPublicationIdentity(m, manifest).digest;
  const changed = createPublicationIdentity({ ...m, creators: [...m.creators].reverse() }, manifest).digest;
  assert.notEqual(baseline, changed);
});

test("unordered keyword and related-identifier order does not affect the digest", () => {
  const m = metadata();
  const baseline = createPublicationIdentity(m, manifest).digest;
  const changed = createPublicationIdentity({
    ...m,
    keywords: [...m.keywords].reverse(),
    relatedIdentifiers: [...m.relatedIdentifiers].reverse(),
  }, manifest).digest;
  assert.equal(baseline, changed);
});

test("selected file mutation changes the digest through the manifest", () => {
  const baseline = createPublicationIdentity(metadata(), manifest).digest;
  const changedManifest: FileManifest = {
    ...manifest,
    entries: manifest.entries.map((entry, index) => index === 0 ? { ...entry, sha256: "c".repeat(64) } : entry),
  };
  const changed = createPublicationIdentity(metadata(), changedManifest).digest;
  assert.notEqual(baseline, changed);
});

test("absent optional value and permitted empty value remain distinct", () => {
  const m = metadata();
  const withEmpty = createPublicationIdentity(m, manifest).digest;
  const { notes: _notes, ...withoutNotes } = m;
  const absent = createPublicationIdentity(withoutNotes, manifest).digest;
  assert.notEqual(withEmpty, absent);
});

test("null optional metadata is rejected rather than canonicalized as absent", () => {
  assert.throws(
    () => createPublicationIdentity({ ...metadata(), license: null }, manifest),
    (error: unknown) => error instanceof PackageIdentityError && error.code === "invalid_metadata",
  );
});

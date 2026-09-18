// DEV ONLY. Regenerates src/lib/__fixtures__/signing-vectors.v1.json from the real signMessage.
//
//   npm run generate:signing-vectors
//
// Every secret below is a dummy literal ("not-real"); this script never touches the master key or any real
// device secret. Each signature can be cross-checked independently of Node with:
//
//   printf '%s\n%s' "$topic" "$body" | openssl dgst -sha256 -hmac "$secret"
//
// Phase 2 firmware mirrors these vectors byte-for-byte to prove it signs identically. Changing a vector (or the
// wire format) means updating the firmware copy too.
import { writeFileSync } from "node:fs";
import { readingsTopic, signMessage } from "../src/lib/deviceMessages.ts";

const OPENSSL_CHECK = `printf '%s\\n%s' "$topic" "$body" | openssl dgst -sha256 -hmac "$secret"`;

// Bodies are built from object literals in firmware key order (firmwareVersion, samples[{recordedAt, values}]),
// with binary-exact floats and whole-second "Z" timestamps (never toISOString, which emits ".000Z").
const inputs = [
  {
    name: "single-temperature-sample",
    secret: "golden-secret-not-real-AAAAAAAAAAAAAAAAAAAA",
    deviceId: "00000000-0000-4000-8000-000000000001",
    body: {
      firmwareVersion: "0.3.0",
      samples: [{ recordedAt: "2023-11-14T22:13:20Z", values: { temperature: 27.5 } }],
    },
  },
  {
    name: "multi-sample-batch",
    secret: "golden-secret-not-real-AAAAAAAAAAAAAAAAAAAA",
    deviceId: "00000000-0000-4000-8000-000000000001",
    body: {
      firmwareVersion: "0.3.0",
      samples: [
        { recordedAt: "2023-11-14T22:13:20Z", values: { temperature: 27.5 } },
        { recordedAt: "2023-11-14T22:14:20Z", values: { temperature: 26.25 } },
        { recordedAt: "2023-11-14T22:15:20Z", values: { temperature: 28 } },
      ],
    },
  },
  {
    name: "second-device",
    secret: "golden-secret-not-real-BBBBBBBBBBBBBBBBBBBB",
    deviceId: "00000000-0000-4000-8000-000000000002",
    body: {
      firmwareVersion: "0.3.0",
      samples: [{ recordedAt: "2023-11-14T22:13:20Z", values: { temperature: 26.25 } }],
    },
  },
];

const vectors = inputs.map(({ name, secret, deviceId, body: bodyObject }) => {
  const topic = readingsTopic(deviceId);
  const body = JSON.stringify(bodyObject);
  const payload = signMessage(secret, topic, body);
  const signature = payload.slice("v1.".length, "v1.".length + 64);
  return { name, secret, deviceId, topic, body, signature, payload };
});

const fixture = {
  format: "v1.<hex HMAC-SHA256 over `${topic}\\n${body}`>.<JSON body>",
  generatedBy: `npm run generate:signing-vectors (scripts/generate-signing-vectors.ts); cross-check: ${OPENSSL_CHECK}`,
  mirroredIn: "firmware test vectors (Phase 2) — keep byte-identical",
  vectors,
};

writeFileSync(
  new URL("../src/lib/__fixtures__/signing-vectors.v1.json", import.meta.url),
  JSON.stringify(fixture, null, 2) + "\n",
);
console.log(`Wrote ${vectors.length} signing vectors to src/lib/__fixtures__/signing-vectors.v1.json`);

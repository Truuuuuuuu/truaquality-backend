// DEV ONLY. Regenerates src/lib/__fixtures__/signing-vectors.v1.json from the real signMessage.
//
//   npm run generate:signing-vectors
//
// Every secret below is a dummy literal ("not-real"); this script never touches the master key or any real
// device secret. Each signature can be cross-checked independently of Node with:
//
//   printf '%s\n%s' "$topic" "$body" | openssl dgst -sha256 -hmac "$secret"
//
// The firmware mirrors these vectors byte-for-byte (firmware/scripts/sync-golden-vectors.mjs) to prove it signs
// identically. Changing a vector (or the wire format, or the firmwareVersion inside every body — now 0.6.0) means
// re-syncing the firmware copy too.
import { writeFileSync } from "node:fs";
import { readingsTopic, signMessage } from "../src/lib/deviceMessages.ts";

const OPENSSL_CHECK = `printf '%s\\n%s' "$topic" "$body" | openssl dgst -sha256 -hmac "$secret"`;

// Bodies are built from object literals in firmware key order (firmwareVersion, wifiSsid, diag{rssi, uptimeS,
// resetReason, freeHeap, queued}, sensors, samples[{recordedAt, values}]), with binary-exact floats and whole-second "Z" timestamps (never toISOString, which emits ".000Z").
//
// A numeric value must also be one the firmware can reproduce: at most 6 significant decimal digits, and either
// 0 or within [1e-5, 1e7). ArduinoJson serializes a float with 6 decimal places (its TextFormatter dispatches on
// the storage width) and switches to exponent notation outside that range, while Node's JSON.stringify prints
// the shortest decimal that round-trips the double. A value outside the intersection makes the native firmware
// suite fail on a one-digit difference deep inside a 200-character body — which reads like a signing bug and is
// not one. assertFirmwareRepresentable() below enforces the rule so it can't be forgotten; realistic
// temperature and turbidity readings at 1-2 decimal places comply comfortably. Every `diag` number must be a
// plain int32 integer, which both serializers print identically.
type VectorInput = {
  name: string;
  secret: string;
  deviceId: string;
  body: {
    firmwareVersion: string;
    wifiSsid?: string;
    diag?: { rssi: number; uptimeS: number; resetReason: string; freeHeap: number; queued: number };
    sensors?: Record<string, string>;
    samples: { recordedAt: string; values: Record<string, number> }[];
  };
};

const inputs: VectorInput[] = [
  {
    name: "single-temperature-sample",
    secret: "golden-secret-not-real-AAAAAAAAAAAAAAAAAAAA",
    deviceId: "00000000-0000-4000-8000-000000000001",
    body: {
      firmwareVersion: "0.6.0",
      samples: [{ recordedAt: "2023-11-14T22:13:20Z", values: { temperature: 27.5 } }],
    },
  },
  {
    name: "multi-sample-batch",
    secret: "golden-secret-not-real-AAAAAAAAAAAAAAAAAAAA",
    deviceId: "00000000-0000-4000-8000-000000000001",
    body: {
      firmwareVersion: "0.6.0",
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
      firmwareVersion: "0.6.0",
      samples: [{ recordedAt: "2023-11-14T22:13:20Z", values: { temperature: 26.25 } }],
    },
  },
  // The three turbidity vectors below pin *bytes*, not the backend's acceptance of them. Turbidity is now a
  // stored parameter (Phase 4), so ingest keeps both values; the vectors already carried it and are deliberately
  // not regenerated, since firmware byte parity is checked against this file. `temperature` is written before
  // `turbidity` in every values object
  // because object-literal order is JSON key order and JSON key order is signed bytes; wire::buildBody emits
  // its addValue calls in the same order.
  {
    name: "temperature-and-turbidity",
    secret: "golden-secret-not-real-AAAAAAAAAAAAAAAAAAAA",
    deviceId: "00000000-0000-4000-8000-000000000001",
    body: {
      firmwareVersion: "0.6.0",
      samples: [{ recordedAt: "2023-11-14T22:13:20Z", values: { temperature: 27.5, turbidity: 12.3 } }],
    },
  },
  {
    // The shape a unit publishes when the DS18B20 is unplugged but turbidity is calibrated: a NAN has no JSON
    // form, so the temperature key is simply absent rather than null or 0.
    name: "turbidity-only-sample",
    secret: "golden-secret-not-real-AAAAAAAAAAAAAAAAAAAA",
    deviceId: "00000000-0000-4000-8000-000000000001",
    body: {
      firmwareVersion: "0.6.0",
      samples: [{ recordedAt: "2023-11-14T22:13:20Z", values: { turbidity: 250.5 } }],
    },
  },
  {
    // The case SENS-03/SENS-04 turn on: a faulted or uncalibrated turbidity sensor drops out of one sample
    // while temperature keeps reporting in the same batch (D-04). "Omitted" IS the temperature-only body.
    name: "turbidity-nan-omitted-in-batch",
    secret: "golden-secret-not-real-AAAAAAAAAAAAAAAAAAAA",
    deviceId: "00000000-0000-4000-8000-000000000001",
    body: {
      firmwareVersion: "0.6.0",
      samples: [
        { recordedAt: "2023-11-14T22:13:20Z", values: { temperature: 27.5, turbidity: 12.3 } },
        { recordedAt: "2023-11-14T22:14:20Z", values: { temperature: 26.25 } },
      ],
    },
  },
  {
    // wifiSsid sits between firmwareVersion and samples (key order is signed bytes). The SSID is chosen to hit
    // every escaping path: a double quote and a backslash (both escaped by ArduinoJson and JSON.stringify) and
    // a non-ASCII character (left raw as UTF-8 by both).
    name: "wifi-ssid-awkward",
    secret: "golden-secret-not-real-AAAAAAAAAAAAAAAAAAAA",
    deviceId: "00000000-0000-4000-8000-000000000001",
    body: {
      firmwareVersion: "0.6.0",
      wifiSsid: 'Bahay "Kubo" \\ Café',
      samples: [{ recordedAt: "2023-11-14T22:13:20Z", values: { temperature: 27.5 } }],
    },
  },
  {
    // Pins the full 0.6.0 key order for the firmware — key order is signed bytes: firmwareVersion, wifiSsid,
    // diag (rssi, uptimeS, resetReason, freeHeap, queued), sensors (temperature before turbidity), samples.
    // Turbidity's status is not "ok", so its value is omitted from the sample exactly as the unit does.
    // Appended last so vectors 0 and 2 keep their indices in both test suites.
    name: "diagnostics-and-sensor-status",
    secret: "golden-secret-not-real-AAAAAAAAAAAAAAAAAAAA",
    deviceId: "00000000-0000-4000-8000-000000000001",
    body: {
      firmwareVersion: "0.6.0",
      wifiSsid: "BFAR-Pond-1",
      diag: { rssi: -67, uptimeS: 86400, resetReason: "power_on", freeHeap: 201344, queued: 3 },
      sensors: { temperature: "ok", turbidity: "no_signal" },
      samples: [{ recordedAt: "2023-11-14T22:13:20Z", values: { temperature: 27.5 } }],
    },
  },
];

const MAX_SIGNIFICANT_DIGITS = 6;
const MIN_ABS = 1e-5;
const MAX_ABS = 1e7;

function refuse(vectorName: string, path: string, value: number, wouldEmit: string): never {
  console.error(
    `Vector "${vectorName}": ${path} = ${value} is not reproducible by the firmware's float serializer — ArduinoJson would emit ${wouldEmit} there, so the unit would sign different bytes than this fixture records.`,
  );
  console.error(
    `A golden-vector number must have at most ${MAX_SIGNIFICANT_DIGITS} significant decimal digits and be either 0 or within [${MIN_ABS}, ${MAX_ABS}). Nothing was written.`,
  );
  process.exit(1);
}

// Recurses rather than reading known parameter names, so a parameter added later (turbidity) is covered without
// touching this function.
function checkValues(vectorName: string, values: unknown, path: string): void {
  if (values === null || typeof values !== "object") {
    return;
  }
  for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
    const keyPath = `${path}.${key}`;
    if (typeof value === "object") {
      checkValues(vectorName, value, keyPath);
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      continue;
    }
    const rounded = Number(value.toPrecision(MAX_SIGNIFICANT_DIGITS));
    if (rounded !== value) {
      refuse(vectorName, keyPath, value, `roughly ${rounded} (it keeps about ${MAX_SIGNIFICANT_DIGITS} significant digits)`);
    }
    const magnitude = Math.abs(value);
    if (magnitude !== 0 && (magnitude < MIN_ABS || magnitude >= MAX_ABS)) {
      refuse(vectorName, keyPath, value, `exponent notation (${value.toExponential()})`);
    }
  }
}

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

function assertFirmwareRepresentable(input: VectorInput): void {
  for (const sample of input.body.samples) {
    checkValues(input.name, sample.values, "values");
  }
  const diag = input.body.diag;
  if (diag) {
    for (const [key, value] of Object.entries(diag)) {
      if (typeof value !== "number") {
        continue;
      }
      if (!Number.isInteger(value) || value < INT32_MIN || value > INT32_MAX) {
        console.error(
          `Vector "${input.name}": diag.${key} = ${value} is not an int32 integer. Every diag number must be one, so ArduinoJson and JSON.stringify emit identical signed bytes (and it fits the Postgres Int column). Nothing was written.`,
        );
        process.exit(1);
      }
    }
  }
}

// Refuse before anything is signed or written: a vector must never be "fixed" later by loosening the firmware.
for (const input of inputs) {
  assertFirmwareRepresentable(input);
}

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

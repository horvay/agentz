import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { hostname, networkInterfaces } from "node:os";
import { join } from "node:path";
import { generate, type GenerateResult } from "selfsigned";

export const REMOTE_RPC_PORT = 4600;

interface RemoteTlsMetadata {
  caFingerprint: string;
  dnsNames: string[];
  ipAddresses: string[];
  serverFingerprint: string;
}

export interface RemoteTlsContext {
  caCert: string;
  caCertPath: string;
  caFingerprint: string;
  cert: string;
  certPath: string;
  ipAddresses: string[];
  key: string;
  keyPath: string;
  serverFingerprint: string;
}

function sanitizeDnsName(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;
  if (!/^[a-z0-9.-]+$/.test(trimmed)) return null;
  return trimmed;
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function resolveDnsNames(): string[] {
  const names = new Set<string>(["localhost"]);
  const host = sanitizeDnsName(hostname());
  if (host) names.add(host);
  return [...names].sort();
}

export function collectReachableIpv4Addresses(): string[] {
  const addresses = new Set<string>(["127.0.0.1"]);
  const interfaces = networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== "IPv4") continue;
      addresses.add(entry.address);
    }
  }
  return [...addresses].sort();
}

export function resolveRemoteAccessUrls(port = REMOTE_RPC_PORT): string[] {
  return collectReachableIpv4Addresses().map((address) => `https://${address}:${port}`);
}

async function generateLocalCa(): Promise<GenerateResult> {
  return generate(
    [{ name: "commonName", value: "agentz Local CA" }],
    {
      algorithm: "sha256",
      keySize: 2048,
      notAfterDate: new Date(Date.now() + 1000 * 60 * 60 * 24 * 3650),
      extensions: [
        { name: "basicConstraints", cA: true },
        {
          name: "keyUsage",
          digitalSignature: true,
          keyCertSign: true,
          cRLSign: true,
        },
        {
          name: "subjectAltName",
          altNames: [{ type: 2 as const, value: "agentz-local-ca" }],
        },
      ],
    },
  );
}

async function generateServerCertificate(
  ca: { key: string; cert: string },
  dnsNames: string[],
  ipAddresses: string[],
): Promise<GenerateResult> {
  return generate(
    [{ name: "commonName", value: dnsNames[0] ?? ipAddresses[0] ?? "localhost" }],
    {
      algorithm: "sha256",
      keySize: 2048,
      notAfterDate: new Date(Date.now() + 1000 * 60 * 60 * 24 * 825),
      ca,
      extensions: [
        { name: "basicConstraints", cA: false },
        {
          name: "keyUsage",
          digitalSignature: true,
          keyEncipherment: true,
        },
        {
          name: "extKeyUsage",
          serverAuth: true,
        },
        {
          name: "subjectAltName",
          altNames: [
            ...dnsNames.map((value) => ({ type: 2 as const, value })),
            ...ipAddresses.map((ip) => ({ type: 7 as const, ip })),
          ],
        },
      ],
    },
  );
}

export async function ensureRemoteTlsContext(configDir: string): Promise<RemoteTlsContext> {
  const caKeyPath = join(configDir, "remote-access.ca.key.pem");
  const caCertPath = join(configDir, "remote-access.ca.cert.pem");
  const keyPath = join(configDir, "remote-access.key.pem");
  const certPath = join(configDir, "remote-access.cert.pem");
  const metadataPath = join(configDir, "remote-access.cert.json");
  const dnsNames = resolveDnsNames();
  const ipAddresses = collectReachableIpv4Addresses();

  if (existsSync(caKeyPath) && existsSync(caCertPath) && existsSync(keyPath) && existsSync(certPath) && existsSync(metadataPath)) {
    try {
      const [caKey, caCert, key, cert, metadataText] = await Promise.all([
        readFile(caKeyPath, "utf8"),
        readFile(caCertPath, "utf8"),
        readFile(keyPath, "utf8"),
        readFile(certPath, "utf8"),
        readFile(metadataPath, "utf8"),
      ]);
      const metadata = JSON.parse(metadataText) as Partial<RemoteTlsMetadata>;
      if (sameList(metadata.dnsNames ?? [], dnsNames) && sameList(metadata.ipAddresses ?? [], ipAddresses)) {
        return {
          caCert,
          caCertPath,
          caFingerprint: metadata.caFingerprint ?? "",
          cert,
          certPath,
          ipAddresses,
          key,
          keyPath,
          serverFingerprint: metadata.serverFingerprint ?? "",
        };
      }
      void caKey; // keep read to validate file exists and is readable
    } catch {
      // Fall through and regenerate the signed leaf cert (and CA if needed).
    }
  }

  await mkdir(configDir, { recursive: true });

  let caKey: string;
  let caCert: string;
  let caFingerprint: string;

  if (existsSync(caKeyPath) && existsSync(caCertPath)) {
    try {
      [caKey, caCert] = await Promise.all([
        readFile(caKeyPath, "utf8"),
        readFile(caCertPath, "utf8"),
      ]);
      const previousMetadataText = existsSync(metadataPath) ? await readFile(metadataPath, "utf8") : null;
      const previousMetadata = previousMetadataText ? JSON.parse(previousMetadataText) as Partial<RemoteTlsMetadata> : null;
      caFingerprint = previousMetadata?.caFingerprint ?? "";
    } catch {
      const generatedCa = await generateLocalCa();
      caKey = generatedCa.private;
      caCert = generatedCa.cert;
      caFingerprint = generatedCa.fingerprint;
    }
  } else {
    const generatedCa = await generateLocalCa();
    caKey = generatedCa.private;
    caCert = generatedCa.cert;
    caFingerprint = generatedCa.fingerprint;
  }

  const server = await generateServerCertificate({ key: caKey, cert: caCert }, dnsNames, ipAddresses);

  const metadata: RemoteTlsMetadata = {
    caFingerprint,
    dnsNames,
    ipAddresses,
    serverFingerprint: server.fingerprint,
  };

  await Promise.all([
    writeFile(caKeyPath, caKey, "utf8"),
    writeFile(caCertPath, caCert, "utf8"),
    writeFile(keyPath, server.private, "utf8"),
    writeFile(certPath, server.cert, "utf8"),
    writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8"),
  ]);

  return {
    caCert,
    caCertPath,
    caFingerprint,
    cert: server.cert,
    certPath,
    ipAddresses,
    key: server.private,
    keyPath,
    serverFingerprint: server.fingerprint,
  };
}

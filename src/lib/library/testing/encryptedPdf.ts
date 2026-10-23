import { createHash } from "node:crypto";

/**
 * Test fixtures only: a one-page PDF encrypted with the PDF standard
 * security handler (revision 2, 40-bit RC4 -- PDF 1.7 spec, algorithms
 * 3.1-3.4), which poppler reads. No qpdf/pdftk/Ghostscript is installed
 * here and pdf-lib can't encrypt, so this builds the file by hand.
 *
 *   userPassword ""        opens without a password; `permissions` restrict it
 *   userPassword "secret"  needs the password to open at all
 */

const PAD = Buffer.from(
  "28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a",
  "hex"
);

function padPassword(pw: string): Buffer {
  const b = Buffer.from(pw, "latin1").subarray(0, 32);
  return Buffer.concat([b, PAD.subarray(0, 32 - b.length)]);
}

function rc4(key: Buffer, data: Buffer): Buffer {
  const s = Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 0xff;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = Buffer.alloc(data.length);
  let i = 0;
  j = 0;
  for (let k = 0; k < data.length; k++) {
    i = (i + 1) & 0xff;
    j = (j + s[i]) & 0xff;
    [s[i], s[j]] = [s[j], s[i]];
    out[k] = data[k] ^ s[(s[i] + s[j]) & 0xff];
  }
  return out;
}

const md5 = (...parts: Buffer[]) => createHash("md5").update(Buffer.concat(parts)).digest();

/** Permission bits (PDF spec table 3.20). Bits 7-8 and 13-32 must be 1; 1-2 must be 0. */
export const PERMISSIONS = {
  all: -4, // 0xFFFFFFFC
  /** print, modify, copy and annotate all denied. */
  none: -64, // 0xFFFFFFC0
};

export function encryptedPdf(options: { text: string; userPassword: string; ownerPassword: string; permissions: number }): Buffer {
  const id = createHash("md5").update(options.text).digest();
  const p = Buffer.alloc(4);
  p.writeInt32LE(options.permissions);

  // Algorithm 3.3: the O entry.
  const ownerKey = md5(padPassword(options.ownerPassword || options.userPassword)).subarray(0, 5);
  const O = rc4(ownerKey, padPassword(options.userPassword));
  // Algorithm 3.2: the file key. Algorithm 3.4: the U entry.
  const key = md5(padPassword(options.userPassword), O, p, id).subarray(0, 5);
  const U = rc4(key, PAD);

  const objectKey = (num: number) => {
    const n = Buffer.from([num & 0xff, (num >> 8) & 0xff, (num >> 16) & 0xff, 0, 0]);
    return md5(key, n).subarray(0, 10);
  };

  const escaped = options.text.replace(/[\\()]/g, (c) => `\\${c}`);
  const content = Buffer.from(`BT /F1 14 Tf 50 700 Td (${escaped}) Tj ET`, "latin1");
  const encryptedContent = rc4(objectKey(4), content);

  const objects: Buffer[] = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>"),
    Buffer.concat([
      Buffer.from(`<< /Length ${encryptedContent.length} >>\nstream\n`),
      encryptedContent,
      Buffer.from("\nendstream"),
    ]),
    Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
    Buffer.from(`<< /Filter /Standard /V 1 /R 2 /O <${O.toString("hex")}> /U <${U.toString("hex")}> /P ${options.permissions} >>`),
  ];

  const chunks: Buffer[] = [Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1")];
  let offset = chunks[0].length;
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(offset);
    const obj = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), body, Buffer.from("\nendobj\n")]);
    chunks.push(obj);
    offset += obj.length;
  });
  const xref =
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("") +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Encrypt 6 0 R /ID [<${id.toString("hex")}> <${id.toString("hex")}>] >>\n` +
    `startxref\n${offset}\n%%EOF\n`;
  chunks.push(Buffer.from(xref));
  return Buffer.concat(chunks);
}

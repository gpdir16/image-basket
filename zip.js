const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function u16(n) {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, n, true);
    return b;
}
function u32(n) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n, true);
    return b;
}

function dosDateTime(d) {
    return {
        time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
        date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    };
}

function dedupe(name, taken) {
    if (!taken.has(name)) {
        taken.add(name);
        return name;
    }
    const dot = name.lastIndexOf(".");
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    let i = 1,
        out;
    do {
        out = `${base} (${i++})${ext}`;
    } while (taken.has(out));
    taken.add(out);
    return out;
}

// entries: [{ name, blob }] → Promise<Blob> (application/zip)
async function buildZip(entries) {
    const parts = [];
    const central = [];
    const taken = new Set();
    let offset = 0;
    let added = 0; // blob이 null인 항목은 건너뜀 — EOCD 카운트는 실제 추가 수로
    for (const e of entries) {
        if (!e.blob) continue;
        added++;
        const name = dedupe(e.name || "file", taken);
        const nameBytes = new TextEncoder().encode(name);
        const data = new Uint8Array(await e.blob.arrayBuffer()); // CRC 계산용 임시 사본 (파트는 원본 blob 참조)
        const crc = crc32(data);
        const { time, date } = dosDateTime(new Date());

        const lh = new Uint8Array(30);
        const dv = new DataView(lh.buffer);
        dv.setUint32(0, 0x04034b50, true);
        dv.setUint16(4, 20, true);
        dv.setUint16(6, 0x0800, true); // UTF-8 파일명 플래그
        dv.setUint16(8, 0, true); // STORE
        dv.setUint16(10, time, true);
        dv.setUint16(12, date, true);
        dv.setUint32(14, crc, true);
        dv.setUint32(18, data.length, true);
        dv.setUint32(22, data.length, true);
        dv.setUint16(26, nameBytes.length, true);
        dv.setUint16(28, 0, true);
        parts.push(lh, nameBytes, e.blob);

        const ch = new Uint8Array(46);
        const cdv = new DataView(ch.buffer);
        cdv.setUint32(0, 0x02014b50, true);
        cdv.setUint16(4, 20, true);
        cdv.setUint16(6, 20, true);
        cdv.setUint16(8, 0x0800, true);
        cdv.setUint16(10, 0, true);
        cdv.setUint16(12, time, true);
        cdv.setUint16(14, date, true);
        cdv.setUint32(16, crc, true);
        cdv.setUint32(20, data.length, true);
        cdv.setUint32(24, data.length, true);
        cdv.setUint16(28, nameBytes.length, true);
        cdv.setUint32(42, offset, true);
        central.push(ch, nameBytes);
        offset += 30 + nameBytes.length + data.length;
    }
    const cdStart = offset;
    const cdSize = central.reduce((s, p) => s + p.length, 0);
    const eocd = new Uint8Array(22);
    const edv = new DataView(eocd.buffer);
    edv.setUint32(0, 0x06054b50, true);
    edv.setUint16(8, added, true);
    edv.setUint16(10, added, true);
    edv.setUint32(12, cdSize, true);
    edv.setUint32(16, cdStart, true);
    parts.push(...central, eocd);
    return new Blob(parts, { type: "application/zip" });
}

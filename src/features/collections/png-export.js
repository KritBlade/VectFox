/**
 * ============================================================================
 * VectFox PNG EXPORT/IMPORT
 * ============================================================================
 * Embeds VectFox collection data into PNG files using zTXt chunks.
 *
 * PNG Structure:
 * - 8-byte signature
 * - IHDR chunk (image header)
 * - ... other chunks ...
 * - IEND chunk (end marker)
 *
 * We insert a zTXt chunk containing compressed JSON data.
 * zTXt format: keyword + null + compression_method (0=deflate) + compressed_data
 *
 * Uses browser's native CompressionStream API for deflate compression.
 * Falls back to storing as tEXt (base64, uncompressed) if compression unavailable.
 *
 * @author VectFox
 * @version 1.0.0
 * ============================================================================
 */

import { log } from '../../sillytavern/log.js';

// ============================================================================
// CONSTANTS
// ============================================================================

/** PNG file signature (magic bytes) */
const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

/** Keyword for VectFox data in PNG tEXt/zTXt chunks */
const VectFox_KEYWORD = 'VectFox';

// ============================================================================
// CRC32 CALCULATION (Required for PNG chunks)
// ============================================================================

/** CRC32 lookup table */
let crcTable = null;

/**
 * Generates the CRC32 lookup table
 * @returns {Uint32Array}
 */
function makeCRCTable() {
    if (crcTable) return crcTable;

    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        }
        crcTable[n] = c;
    }
    return crcTable;
}

/**
 * Calculates CRC32 for PNG chunk
 * @param {Uint8Array} data - Data to calculate CRC for
 * @returns {number} CRC32 value
 */
function crc32(data) {
    const table = makeCRCTable();
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) {
        crc = table[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ============================================================================
// COMPRESSION UTILITIES
// ============================================================================

/**
 * Compresses data using browser's native CompressionStream (deflate-raw)
 * @param {Uint8Array} data - Data to compress
 * @returns {Promise<Uint8Array>} Compressed data
 */
async function compressDeflateRaw(data) {
    // Check if CompressionStream supports deflate-raw
    if (typeof CompressionStream !== 'undefined') {
        try {
            const cs = new CompressionStream('deflate-raw');
            const writer = cs.writable.getWriter();
            writer.write(data);
            writer.close();

            const chunks = [];
            const reader = cs.readable.getReader();
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
            }

            // Combine chunks
            const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
            const result = new Uint8Array(totalLength);
            let offset = 0;
            for (const chunk of chunks) {
                result.set(chunk, offset);
                offset += chunk.length;
            }
            return result;
        } catch (e) {
            // deflate-raw might not be supported, try regular deflate
            log.warn('VectFox PNG: deflate-raw not supported, trying deflate:', e);
        }

        try {
            // Regular deflate includes zlib header (2 bytes) and checksum (4 bytes)
            // We need to strip them for zTXt which expects raw deflate
            const cs = new CompressionStream('deflate');
            const writer = cs.writable.getWriter();
            writer.write(data);
            writer.close();

            const chunks = [];
            const reader = cs.readable.getReader();
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
            }

            const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
            const result = new Uint8Array(totalLength);
            let offset = 0;
            for (const chunk of chunks) {
                result.set(chunk, offset);
                offset += chunk.length;
            }

            // Strip zlib header (2 bytes) and adler32 checksum (4 bytes)
            // zlib format: [CMF][FLG][...compressed data...][ADLER32]
            if (result.length > 6) {
                return result.slice(2, result.length - 4);
            }
            return result;
        } catch (e) {
            log.warn('VectFox PNG: Compression failed, will use uncompressed tEXt', e);
            return null;
        }
    }
    return null;
}

/**
 * Decompresses deflate-raw data using browser's native DecompressionStream
 * @param {Uint8Array} data - Compressed data
 * @returns {Promise<Uint8Array>} Decompressed data
 */
async function decompressDeflateRaw(data) {
    if (typeof DecompressionStream !== 'undefined') {
        // Try deflate-raw first
        try {
            const ds = new DecompressionStream('deflate-raw');
            const writer = ds.writable.getWriter();
            writer.write(data);
            writer.close();

            const chunks = [];
            const reader = ds.readable.getReader();
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
            }

            const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
            const result = new Uint8Array(totalLength);
            let offset = 0;
            for (const chunk of chunks) {
                result.set(chunk, offset);
                offset += chunk.length;
            }
            return result;
        } catch (e) {
            // Try wrapping in zlib format for regular deflate decoder
            log.warn('VectFox PNG: deflate-raw decompress failed, trying with zlib wrapper:', e);
        }

        try {
            // Wrap raw deflate in zlib format
            // CMF = 0x78 (deflate, 32K window), FLG = 0x9C (default compression, checksum)
            const zlibData = new Uint8Array(data.length + 6);
            zlibData[0] = 0x78;
            zlibData[1] = 0x9C;
            zlibData.set(data, 2);
            // Add dummy adler32 (will likely cause issues, but worth trying)
            zlibData[zlibData.length - 4] = 0;
            zlibData[zlibData.length - 3] = 0;
            zlibData[zlibData.length - 2] = 0;
            zlibData[zlibData.length - 1] = 1;

            const ds = new DecompressionStream('deflate');
            const writer = ds.writable.getWriter();
            writer.write(zlibData);
            writer.close();

            const chunks = [];
            const reader = ds.readable.getReader();
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
            }

            const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
            const result = new Uint8Array(totalLength);
            let offset = 0;
            for (const chunk of chunks) {
                result.set(chunk, offset);
                offset += chunk.length;
            }
            return result;
        } catch (e) {
            log.error('VectFox PNG: All decompression methods failed', e);
            throw new Error('Failed to decompress PNG data. Browser may not support required compression.');
        }
    }
    throw new Error('DecompressionStream not available in this browser');
}

// ============================================================================
// PNG CHUNK MANIPULATION
// ============================================================================

/**
 * Creates a PNG chunk
 * @param {string} type - 4-character chunk type (e.g., 'tEXt', 'zTXt')
 * @param {Uint8Array} data - Chunk data
 * @returns {Uint8Array} Complete chunk with length, type, data, and CRC
 */
function createChunk(type, data) {
    const typeBytes = new TextEncoder().encode(type);
    const chunk = new Uint8Array(4 + 4 + data.length + 4);
    const view = new DataView(chunk.buffer);

    // Length (4 bytes, big-endian)
    view.setUint32(0, data.length, false);

    // Type (4 bytes)
    chunk.set(typeBytes, 4);

    // Data
    chunk.set(data, 8);

    // CRC (4 bytes, big-endian) - calculated over type + data
    const crcData = new Uint8Array(4 + data.length);
    crcData.set(typeBytes, 0);
    crcData.set(data, 4);
    view.setUint32(8 + data.length, crc32(crcData), false);

    return chunk;
}

/**
 * Parses PNG chunks from binary data
 * @param {Uint8Array} pngData - PNG file data
 * @returns {Array<{type: string, data: Uint8Array, offset: number}>} Array of chunks
 */
function parseChunks(pngData) {
    // Verify PNG signature
    for (let i = 0; i < 8; i++) {
        if (pngData[i] !== PNG_SIGNATURE[i]) {
            throw new Error('Invalid PNG signature');
        }
    }

    const chunks = [];
    let offset = 8; // Skip signature

    while (offset < pngData.length) {
        const view = new DataView(pngData.buffer, pngData.byteOffset + offset);
        const length = view.getUint32(0, false);
        const type = new TextDecoder().decode(pngData.slice(offset + 4, offset + 8));
        const data = pngData.slice(offset + 8, offset + 8 + length);

        chunks.push({ type, data, offset });

        offset += 4 + 4 + length + 4; // length + type + data + crc

        if (type === 'IEND') break;
    }

    return chunks;
}

/**
 * Reconstructs PNG from chunks, inserting a new chunk before IEND
 * @param {Uint8Array} originalPng - Original PNG data
 * @param {Uint8Array} newChunk - New chunk to insert
 * @returns {Uint8Array} New PNG with inserted chunk
 */
function insertChunkBeforeIEND(originalPng, newChunk) {
    const chunks = parseChunks(originalPng);
    const iendIndex = chunks.findIndex(c => c.type === 'IEND');

    if (iendIndex === -1) {
        throw new Error('PNG missing IEND chunk');
    }

    // Calculate new file size
    const iendChunk = chunks[iendIndex];
    const beforeIEND = originalPng.slice(0, iendChunk.offset);
    const iendData = originalPng.slice(iendChunk.offset);

    // Combine: original (minus IEND) + new chunk + IEND
    const result = new Uint8Array(beforeIEND.length + newChunk.length + iendData.length);
    result.set(beforeIEND, 0);
    result.set(newChunk, beforeIEND.length);
    result.set(iendData, beforeIEND.length + newChunk.length);

    return result;
}

// ============================================================================
// EXPORT FUNCTIONS
// ============================================================================

/**
 * Creates a zTXt chunk with compressed data
 * @param {string} keyword - Chunk keyword
 * @param {string} text - Text to compress
 * @returns {Promise<Uint8Array>} zTXt chunk
 */
async function createZTXtChunk(keyword, text) {
    const keywordBytes = new TextEncoder().encode(keyword);
    const textBytes = new TextEncoder().encode(text);

    // Try to compress
    const compressed = await compressDeflateRaw(textBytes);

    if (compressed) {
        // zTXt format: keyword + null + compression_method (0) + compressed_data
        const data = new Uint8Array(keywordBytes.length + 1 + 1 + compressed.length);
        data.set(keywordBytes, 0);
        data[keywordBytes.length] = 0; // Null separator
        data[keywordBytes.length + 1] = 0; // Compression method 0 = deflate
        data.set(compressed, keywordBytes.length + 2);

        log.lifecycle(`VectFox PNG: Compressed ${textBytes.length} bytes to ${compressed.length} bytes (${Math.round(compressed.length / textBytes.length * 100)}%)`);

        return createChunk('zTXt', data);
    } else {
        // Fall back to tEXt with base64 encoding
        log.warn('VectFox PNG: Using uncompressed tEXt chunk (compression unavailable)');
        const base64 = btoa(String.fromCharCode(...textBytes));
        const base64Bytes = new TextEncoder().encode(base64);

        // tEXt format: keyword + null + text
        const data = new Uint8Array(keywordBytes.length + 1 + base64Bytes.length);
        data.set(keywordBytes, 0);
        data[keywordBytes.length] = 0;
        data.set(base64Bytes, keywordBytes.length + 1);

        return createChunk('tEXt', data);
    }
}

/**
 * Reads a tEXt or zTXt chunk
 * @param {object} chunk - Parsed chunk {type, data}
 * @returns {Promise<{keyword: string, text: string} | null>}
 */
async function readTextChunk(chunk) {
    if (chunk.type !== 'tEXt' && chunk.type !== 'zTXt') {
        return null;
    }

    // Find null separator
    let nullIndex = -1;
    for (let i = 0; i < chunk.data.length; i++) {
        if (chunk.data[i] === 0) {
            nullIndex = i;
            break;
        }
    }

    if (nullIndex === -1) return null;

    const keyword = new TextDecoder().decode(chunk.data.slice(0, nullIndex));

    if (chunk.type === 'tEXt') {
        // tEXt: keyword + null + text
        const textData = chunk.data.slice(nullIndex + 1);
        const text = new TextDecoder().decode(textData);

        // Check if it's base64 encoded (our fallback format)
        try {
            const decoded = atob(text);
            return { keyword, text: decoded };
        } catch {
            return { keyword, text };
        }
    } else {
        // zTXt: keyword + null + compression_method + compressed_data
        const compressionMethod = chunk.data[nullIndex + 1];
        if (compressionMethod !== 0) {
            throw new Error(`Unsupported compression method: ${compressionMethod}`);
        }

        const compressedData = chunk.data.slice(nullIndex + 2);
        const decompressed = await decompressDeflateRaw(compressedData);
        const text = new TextDecoder().decode(decompressed);

        return { keyword, text };
    }
}

/**
 * Converts any image to PNG using canvas
 * @param {File|Blob} imageFile - Image file
 * @returns {Promise<Uint8Array>} PNG data
 */
export async function convertToPNG(imageFile) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        const url = URL.createObjectURL(imageFile);

        img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = img.height;

            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0);

            canvas.toBlob((blob) => {
                URL.revokeObjectURL(url);

                if (!blob) {
                    reject(new Error('Failed to convert image to PNG'));
                    return;
                }

                blob.arrayBuffer().then(buffer => {
                    resolve(new Uint8Array(buffer));
                }).catch(reject);
            }, 'image/png');
        };

        img.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error('Failed to load image'));
        };

        img.src = url;
    });
}

/**
 * Creates a default placeholder PNG for exports
 * @param {number} width - Image width
 * @param {number} height - Image height
 * @param {string} text - Text to display
 * @returns {Promise<Uint8Array>} PNG data
 */
export async function createDefaultPNG(width = 512, height = 512, text = 'VectFox Collection') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext('2d');

    // Background gradient
    const gradient = ctx.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, '#2d1b4e');
    gradient.addColorStop(1, '#1a1a2e');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);

    // Draw hare silhouette (simple)
    ctx.fillStyle = '#8b5cf6';
    ctx.beginPath();
    // Body
    ctx.ellipse(width/2, height/2 + 50, 80, 60, 0, 0, Math.PI * 2);
    ctx.fill();
    // Head
    ctx.beginPath();
    ctx.ellipse(width/2, height/2 - 30, 50, 45, 0, 0, Math.PI * 2);
    ctx.fill();
    // Ears
    ctx.beginPath();
    ctx.ellipse(width/2 - 25, height/2 - 120, 15, 50, -0.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(width/2 + 25, height/2 - 120, 15, 50, 0.2, 0, Math.PI * 2);
    ctx.fill();

    // Text
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 24px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(text, width/2, height - 60);

    ctx.font = '16px sans-serif';
    ctx.fillStyle = '#a78bfa';
    ctx.fillText('VectFox Export', width/2, height - 30);

    return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
            if (!blob) {
                reject(new Error('Failed to create PNG'));
                return;
            }
            blob.arrayBuffer().then(buffer => {
                resolve(new Uint8Array(buffer));
            }).catch(reject);
        }, 'image/png');
    });
}

/**
 * Embeds VectFox export data into a PNG image
 * @param {object} exportData - VectFox export data object
 * @param {Uint8Array|null} pngData - Base PNG image (null = use default)
 * @returns {Promise<Uint8Array>} PNG with embedded data
 */
export async function embedDataInPNG(exportData, pngData = null) {
    // Use default image if none provided
    if (!pngData) {
        const collectionName = exportData.collection?.name ||
            (exportData.type === 'multi' ? `${exportData.stats?.totalCollections || 0} Collections` : 'Collection');
        pngData = await createDefaultPNG(512, 512, collectionName);
    }

    // Convert export data to JSON string
    const jsonString = JSON.stringify(exportData);

    // Create zTXt chunk with compressed data
    const textChunk = await createZTXtChunk(VectFox_KEYWORD, jsonString);

    // Insert chunk into PNG
    const result = insertChunkBeforeIEND(pngData, textChunk);

    log.lifecycle(`VectFox PNG: Created PNG export (${result.length} bytes, original JSON: ${jsonString.length} bytes)`);

    return result;
}

/**
 * Extracts VectFox data from a PNG image
 * @param {Uint8Array} pngData - PNG file data
 * @returns {Promise<object|null>} Extracted export data or null if not found
 */
export async function extractDataFromPNG(pngData) {
    const chunks = parseChunks(pngData);

    // Look for VectFox keyword in text chunks
    for (const chunk of chunks) {
        if (chunk.type === 'tEXt' || chunk.type === 'zTXt') {
            try {
                const textData = await readTextChunk(chunk);
                if (textData && textData.keyword === VectFox_KEYWORD) {
                    const exportData = JSON.parse(textData.text);
                    log.lifecycle('VectFox PNG: Successfully extracted data from PNG');
                    return exportData;
                }
            } catch (e) {
                log.warn('VectFox PNG: Failed to read text chunk:', e);
            }
        }
    }

    return null;
}

/**
 * Downloads PNG data as a file
 * @param {Uint8Array} pngData - PNG data
 * @param {string} filename - Filename (without extension)
 */
export function downloadPNG(pngData, filename) {
    const blob = new Blob([pngData], { type: 'image/png' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = filename.endsWith('.png') ? filename : `${filename}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    log.lifecycle(`VectFox PNG: Downloaded ${a.download}`);
}

/**
 * Reads a PNG file from a File object
 * @param {File} file - File object
 * @returns {Promise<Uint8Array>} PNG data
 */
export async function readPNGFile(file) {
    const buffer = await file.arrayBuffer();
    return new Uint8Array(buffer);
}


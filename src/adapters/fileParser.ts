import { fetch } from '@tauri-apps/plugin-http';
import { extractRawText } from 'mammoth';
import { Buffer } from 'buffer';

// Dynamic import for pdf-parse to avoid ESM/CJS issues
let pdfParse: any = null;
async function getPdfParse() {
  if (!pdfParse) {
    try {
      const module = await import('pdf-parse');
      // Handle both default and named exports
      pdfParse = module.default || module;
      console.log('PDF parser loaded, type:', typeof pdfParse);
    } catch (error) {
      console.error('Failed to load pdf-parse:', error);
    }
  }
  return pdfParse;
}

// Rate limiting to avoid 429 errors
let lastDownloadTime = 0;
const MIN_DOWNLOAD_INTERVAL = 500; // 500ms between downloads

async function rateLimit() {
  const now = Date.now();
  const timeSinceLastDownload = now - lastDownloadTime;
  if (timeSinceLastDownload < MIN_DOWNLOAD_INTERVAL) {
    await new Promise(resolve => setTimeout(resolve, MIN_DOWNLOAD_INTERVAL - timeSinceLastDownload));
  }
  lastDownloadTime = Date.now();
}

/**
 * Downloads and extracts text content from files
 */
export async function downloadAndParseFile(
  fileUrl: string,
  mimetype: string,
  token: string
): Promise<string | null> {
  try {
    // Rate limit to avoid 429 errors
    await rateLimit();
    
    // Download the file
    const response = await fetch(fileUrl, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    if (!response.ok) {
      console.error(`Failed to download file: ${response.status}`);
      return null;
    }

    // Get file as buffer
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Parse based on mimetype
    if (mimetype.includes('pdf')) {
      return await parsePDF(buffer);
    } else if (mimetype.includes('word') || mimetype.includes('document') || fileUrl.endsWith('.docx')) {
      return await parseWord(arrayBuffer);
    } else if (mimetype.includes('text') || mimetype.includes('markdown') || fileUrl.endsWith('.md') || fileUrl.endsWith('.txt')) {
      return buffer.toString('utf-8');
    } else {
      // Try to decode as text for unknown types
      try {
        return buffer.toString('utf-8');
      } catch {
        console.warn(`Unsupported file type: ${mimetype}`);
        return null;
      }
    }
  } catch (error) {
    console.error('Error downloading/parsing file:', error);
    return null;
  }
}

async function parsePDF(buffer: Buffer): Promise<string> {
  try {
    const module = await getPdfParse();
    if (!module) {
      console.error('PDF parser module not loaded');
      return '';
    }
    
    // The module has a PDFParse function we need to use
    const parse = module.PDFParse || module.default || module;
    
    if (!parse || typeof parse !== 'function') {
      console.error('PDFParse function not found in module');
      console.error('Available keys:', Object.keys(module));
      return '';
    }
    
    // Convert Buffer to Uint8Array for pdf-parse
    const uint8Array = new Uint8Array(buffer);
    const data = await parse(uint8Array);
    return data.text || '';
  } catch (error) {
    console.error('PDF parsing error:', error);
    return '';
  }
}

async function parseWord(arrayBuffer: ArrayBuffer): Promise<string> {
  try {
    // Validate the arrayBuffer
    if (!arrayBuffer || arrayBuffer.byteLength === 0) {
      console.error('Invalid or empty ArrayBuffer for Word document');
      return '';
    }
    
    // Check if it looks like a ZIP file (Word docs are ZIP archives)
    const bytes = new Uint8Array(arrayBuffer);
    const isZip = bytes[0] === 0x50 && bytes[1] === 0x4B; // PK header
    
    if (!isZip) {
      console.warn('File does not appear to be a valid Word document (missing ZIP header)');
      return '';
    }
    
    const result = await extractRawText({ arrayBuffer });
    return result.value;
  } catch (error) {
    console.error('Word document parsing error:', error);
    return '';
  }
}

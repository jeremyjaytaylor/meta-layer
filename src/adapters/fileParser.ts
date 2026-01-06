import { fetch } from '@tauri-apps/plugin-http';
import { extractRawText } from 'mammoth';
import { Buffer } from 'buffer';
import pdfParse from 'pdf-parse';

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
    console.log('📄 Parsing PDF with buffer of size:', buffer.length);
    console.log('   pdfParse type:', typeof pdfParse);
    
    if (typeof pdfParse !== 'function') {
      console.error('❌ pdfParse is not a function, type:', typeof pdfParse);
      return '';
    }
    
    // Call pdf-parse with the buffer
    const result = await pdfParse(buffer);
    
    console.log('📊 PDF parse result type:', typeof result);
    console.log('   Result keys:', result ? Object.keys(result).join(', ') : 'null');
    
    // Extract text from result
    if (result && typeof result.text === 'string') {
      console.log(`✅ PDF parsed successfully: ${result.text.length} characters`);
      return result.text;
    }
    
    console.warn('⚠️ PDF parse result has unexpected structure');
    return '';
  } catch (error) {
    console.error('❌ PDF parsing error:', error);
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
      console.warn('File does not appear to be a valid Word document (missing ZIP header), trying plain text extraction...');
      // Try to extract as plain text
      try {
        const decoder = new TextDecoder('utf-8');
        return decoder.decode(arrayBuffer);
      } catch {
        return '';
      }
    }
    
    const result = await extractRawText({ arrayBuffer });
    console.log(`✅ Word document parsed successfully: ${result.value.length} characters`);
    return result.value;
  } catch (error) {
    console.error('Word document parsing error:', error);
    // Fallback to plain text if parsing fails
    try {
      const decoder = new TextDecoder('utf-8');
      const text = decoder.decode(arrayBuffer);
      console.log('📝 Extracted as plain text instead');
      return text;
    } catch {
      return '';
    }
  }
}

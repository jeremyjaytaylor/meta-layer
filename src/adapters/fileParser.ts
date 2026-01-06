import { fetch } from '@tauri-apps/plugin-http';
import { extractRawText } from 'mammoth';
import { Buffer } from 'buffer';

// Dynamic import for pdf-parse to avoid ESM/CJS issues
let pdfParse: any = null;
async function getPdfParse() {
  if (!pdfParse) {
    try {
      const module = await import('pdf-parse');
      console.log('📦 PDF module loaded:', Object.keys(module));
      console.log('   module type:', typeof module);
      console.log('   module.default type:', typeof module.default);
      
      // Handle both default and named exports
      pdfParse = module.default || module;
      console.log('✅ PDF parser type:', typeof pdfParse);
      
      if (typeof pdfParse !== 'function') {
        console.error('❌ PDF parser is not a function! Keys:', Object.keys(pdfParse || {}));
      }
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
    const pdfParser = await getPdfParse();
    if (!pdfParser) {
      console.error('❌ PDF parser module not loaded');
      return '';
    }
    
    if (typeof pdfParser !== 'function') {
      console.error('❌ PDF parser is not a function, type:', typeof pdfParser);
      console.error('   Available keys:', Object.keys(pdfParser || {}));
      
      // Try to find the actual parser function in the object
      if (pdfParser && typeof pdfParser.default === 'function') {
        console.log('🔄 Trying pdfParser.default...');
        const result = await pdfParser.default(buffer);
        if (result && typeof result.text === 'string') {
          console.log(`✅ PDF parsed successfully: ${result.text.length} characters`);
          return result.text;
        }
      }
      
      return '';
    }
    
    console.log('📄 Calling PDF parser on buffer of size:', buffer.length);
    
    // Call the parser function directly with the buffer
    const result = await pdfParser(buffer);
    
    console.log('📊 PDF parse result:', typeof result, result ? Object.keys(result) : 'null');
    
    // Extract text from result
    if (result && typeof result.text === 'string') {
      console.log(`✅ PDF parsed successfully: ${result.text.length} characters`);
      return result.text;
    }
    
    console.warn('⚠️ PDF parse result has no text property');
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

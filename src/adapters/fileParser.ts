import { fetch } from '@tauri-apps/plugin-http';
import { extractRawText } from 'mammoth';
import { Buffer } from 'buffer';

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
    
    // Dynamic import pdf-parse
    const pdfParseModule = await import('pdf-parse');
    console.log('📦 pdf-parse module keys:', Object.keys(pdfParseModule));
    console.log('   default type:', typeof (pdfParseModule as any).default);
    console.log('   PDFParse type:', typeof (pdfParseModule as any).PDFParse);
    
    // Configure GlobalWorkerOptions for pdf.js (used internally by pdf-parse)
    const pdfjsLib = (pdfParseModule as any).pdfjsLib || (globalThis as any).pdfjsLib;
    if (pdfjsLib && pdfjsLib.GlobalWorkerOptions) {
      // Use version 5.4.296 to match the API version - try multiple CDN URLs
      const workerUrls = [
        'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/5.4.296/pdf.worker.min.js',
        'https://unpkg.com/pdfjs-dist@5.4.296/build/pdf.worker.min.js',
        'https://cdn.jsdelivr.net/npm/pdfjs-dist@5.4.296/build/pdf.worker.min.js'
      ];
      pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrls[0];
      console.log('✅ Configured PDF.js worker v5.4.296');
    }
    
    // The pdf-parse library exports a PDFParse class that needs to be instantiated
    // and then its parse() method called
    let result: any;
    
    if ((pdfParseModule as any).PDFParse) {
      console.log('🔧 Using PDFParse class');
      const PDFParseClass = (pdfParseModule as any).PDFParse;
      const parser = new PDFParseClass(buffer);
      
      console.log('   Parser created, keys:', Object.keys(parser).slice(0, 10).join(', '));
      console.log('   Has parse method:', typeof parser.parse);
      
      // Call the parse method if it exists
      if (typeof parser.parse === 'function') {
        console.log('   Calling parser.parse()...');
        result = await parser.parse();
      } else {
        // Maybe the constructor itself returns the result
        result = parser;
      }
    } else if (typeof (pdfParseModule as any).default === 'function') {
      console.log('🔧 Using default export as function');
      result = await (pdfParseModule as any).default(buffer);
    } else {
      console.error('❌ Could not determine how to call pdf-parse');
      console.log('   Module structure:', JSON.stringify(Object.keys(pdfParseModule)));
      return '';
    }
    
    console.log('📊 Parse result type:', typeof result);
    console.log('   Result keys:', result ? Object.keys(result).slice(0, 15).join(', ') : 'null');
    
    // Extract text from result - try multiple possible locations
    if (result && typeof result.text === 'string') {
      console.log(`✅ PDF parsed successfully: ${result.text.length} characters`);
      console.log(`   First 200 chars: ${result.text.substring(0, 200)}`);
      return result.text;
    }
    
    // Maybe text is nested
    if (result && result.data && typeof result.data.text === 'string') {
      console.log(`✅ PDF text found in result.data.text: ${result.data.text.length} characters`);
      return result.data.text;
    }
    
    // Check if there's a getText method
    if (result && typeof result.getText === 'function') {
      const text = await result.getText();
      console.log(`✅ PDF text from getText(): ${text.length} characters`);
      return text;
    }
    
    console.error('⚠️ PDF result missing text property. Available keys:', result ? Object.keys(result) : 'none');
    console.error('   Result sample:', result ? JSON.stringify(result).substring(0, 500) : 'null');
    return '';
  } catch (error) {
    console.error('❌ PDF parsing error:', error);
    if (error instanceof Error) {
      console.error('   Error name:', error.name);
      console.error('   Error message:', error.message);
      console.error('   Stack:', error.stack?.substring(0, 300));
    }
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

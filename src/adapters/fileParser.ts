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

    // Parse directly with pdfjs-dist, disable worker to avoid network fetches
    const pdfjsLib = await import('pdfjs-dist');
    if (pdfjsLib && (pdfjsLib as any).GlobalWorkerOptions) {
      (pdfjsLib as any).GlobalWorkerOptions.workerSrc = null;
      console.log('✅ Disabled PDF.js worker (using main thread)');
    }

    const loadingTask = (pdfjsLib as any).getDocument({
      data: buffer,
      disableWorker: true,
      isEvalSupported: false
    });

    const doc = await loadingTask.promise;
    const maxPages = doc.numPages;
    let fullText = '';

    for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
      const page = await doc.getPage(pageNum);
      const content = await page.getTextContent();
      const strings = content.items
        .map((item: any) => item.str)
        .filter((s: string) => typeof s === 'string');
      fullText += strings.join(' ') + '\n\n';
    }

    console.log(`✅ PDF parsed successfully: ${fullText.length} characters`);
    console.log(`   First 200 chars: ${fullText.substring(0, 200)}`);
    return fullText;
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
        const text = decoder.decode(arrayBuffer).trim();
        if (text.length > 0) {
          console.log(`📝 Extracted plain text fallback: ${text.length} characters`);
          return text;
        }
      } catch {
        /* ignore */
      }
      return '';
    }

    const result = await extractRawText({ arrayBuffer });
    console.log(`✅ Word document parsed successfully: ${result.value.length} characters`);
    return result.value;
  } catch (error) {
    console.error('Word document parsing error:', error);
    // Fallback to plain text if parsing fails
    try {
      const decoder = new TextDecoder('utf-8');
      const text = decoder.decode(arrayBuffer).trim();
      if (text.length > 0) {
        console.log('📝 Extracted as plain text instead');
        return text;
      }
      return '';
    } catch {
      return '';
    }
  }
}

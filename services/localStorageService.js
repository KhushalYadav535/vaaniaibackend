/**
 * Local File Storage Service for VPS
 * Store call recordings and transcripts on local disk
 */
const fs = require('fs');
const path = require('path');
const { promises: fsPromises } = require('fs');

class LocalStorageService {
  constructor() {
    this.baseDir = process.env.STORAGE_PATH || './recordings';
    this.initializeStorage();
  }

  initializeStorage() {
    // Create base directory if not exists
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
      console.log(`📁 Storage directory created: ${this.baseDir}`);
    }

    // Create subdirectories
    const dirs = ['calls', 'transcripts', 'logs'];
    dirs.forEach(dir => {
      const dirPath = path.join(this.baseDir, dir);
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
      }
    });
  }

  /**
   * Save recording file
   */
  async saveRecording({ recordingBuffer, callSid, userId, agentId, mimeType = 'audio/mpeg' }) {
    try {
      const fileName = `${callSid}-${Date.now()}.mp3`;
      const userDir = path.join(this.baseDir, 'calls', userId.toString(), agentId.toString());
      
      // Create user/agent directory
      await fsPromises.mkdir(userDir, { recursive: true });

      const filePath = path.join(userDir, fileName);

      // Write file
      await fsPromises.writeFile(filePath, recordingBuffer);

      // Get file size
      const stats = await fsPromises.stat(filePath);

      console.log(`✅ Recording saved: ${filePath} (${stats.size} bytes)`);

      return {
        success: true,
        path: filePath,
        relativePath: path.relative(this.baseDir, filePath),
        fileName,
        size: stats.size,
        mimeType,
        timestamp: new Date().toISOString(),
        url: `/api/recordings/${userId}/${agentId}/${fileName}`,
      };
    } catch (error) {
      console.error('❌ Recording save failed:', error.message);
      throw error;
    }
  }

  /**
   * Save transcript as JSON
   */
  async saveTranscript({ transcript, callSid, userId, agentId }) {
    try {
      const fileName = `${callSid}-transcript.json`;
      const userDir = path.join(this.baseDir, 'transcripts', userId.toString(), agentId.toString());

      await fsPromises.mkdir(userDir, { recursive: true });

      const filePath = path.join(userDir, fileName);

      // Write transcript JSON
      await fsPromises.writeFile(
        filePath,
        JSON.stringify(transcript, null, 2),
        'utf-8'
      );

      console.log(`✅ Transcript saved: ${filePath}`);

      return {
        success: true,
        path: filePath,
        relativePath: path.relative(this.baseDir, filePath),
        fileName,
        url: `/api/transcripts/${userId}/${agentId}/${fileName}`,
      };
    } catch (error) {
      console.error('❌ Transcript save failed:', error.message);
      throw error;
    }
  }

  /**
   * Save call log
   */
  async saveCallLog({ callLog, userId }) {
    try {
      const fileName = `${callLog._id}.json`;
      const userDir = path.join(this.baseDir, 'logs', userId.toString());

      await fsPromises.mkdir(userDir, { recursive: true });

      const filePath = path.join(userDir, fileName);

      await fsPromises.writeFile(
        filePath,
        JSON.stringify(callLog, null, 2),
        'utf-8'
      );

      return {
        success: true,
        path: filePath,
      };
    } catch (error) {
      console.error('❌ Call log save failed:', error.message);
      throw error;
    }
  }

  /**
   * Read recording file
   */
  async readRecording({ filePath }) {
    try {
      const fullPath = path.join(this.baseDir, filePath);
      
      // Security check: prevent directory traversal
      if (!fullPath.startsWith(this.baseDir)) {
        throw new Error('Invalid file path');
      }

      const data = await fsPromises.readFile(fullPath);
      return data;
    } catch (error) {
      console.error('❌ Recording read failed:', error.message);
      throw error;
    }
  }

  /**
   * List recordings for a user
   */
  async listRecordings({ userId, agentId, limit = 50 }) {
    try {
      const userDir = path.join(this.baseDir, 'calls', userId.toString(), agentId.toString());

      if (!fs.existsSync(userDir)) {
        return [];
      }

      const files = await fsPromises.readdir(userDir);
      const recordings = [];

      for (const file of files.slice(-limit)) {
        const filePath = path.join(userDir, file);
        const stats = await fsPromises.stat(filePath);

        recordings.push({
          fileName: file,
          size: stats.size,
          createdAt: stats.mtime,
          url: `/api/recordings/${userId}/${agentId}/${file}`,
          relativePath: path.relative(this.baseDir, filePath),
        });
      }

      return recordings.reverse(); // Most recent first
    } catch (error) {
      console.error('❌ List recordings failed:', error.message);
      return [];
    }
  }

  /**
   * Delete recording
   */
  async deleteRecording({ userId, agentId, fileName }) {
    try {
      const filePath = path.join(this.baseDir, 'calls', userId.toString(), agentId.toString(), fileName);

      // Security check
      if (!filePath.startsWith(this.baseDir)) {
        throw new Error('Invalid file path');
      }

      if (fs.existsSync(filePath)) {
        await fsPromises.unlink(filePath);
        console.log(`✅ Recording deleted: ${filePath}`);
        return { success: true };
      }

      return { success: false, message: 'File not found' };
    } catch (error) {
      console.error('❌ Delete recording failed:', error.message);
      throw error;
    }
  }

  /**
   * Get storage stats
   */
  async getStorageStats() {
    try {
      const getSize = async (dirPath) => {
        let size = 0;
        const files = await fsPromises.readdir(dirPath, { withFileTypes: true });

        for (const file of files) {
          const fullPath = path.join(dirPath, file.name);
          if (file.isDirectory()) {
            size += await getSize(fullPath);
          } else {
            const stats = await fsPromises.stat(fullPath);
            size += stats.size;
          }
        }

        return size;
      };

      const totalSize = await getSize(this.baseDir);

      // Convert to human-readable format
      const formatSize = (bytes) => {
        const sizes = ['B', 'KB', 'MB', 'GB'];
        if (bytes === 0) return '0 B';
        const i = Math.floor(Math.log(bytes) / Math.log(1024));
        return Math.round((bytes / Math.pow(1024, i)) * 100) / 100 + ' ' + sizes[i];
      };

      return {
        success: true,
        totalSize,
        formattedSize: formatSize(totalSize),
        basePath: this.baseDir,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      console.error('❌ Storage stats failed:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Cleanup old recordings (older than X days)
   */
  async cleanupOldRecordings({ daysOld = 30 } = {}) {
    try {
      const cutoffDate = Date.now() - (daysOld * 24 * 60 * 60 * 1000);
      let deletedCount = 0;
      let deletedSize = 0;

      const cleanupDir = async (dirPath) => {
        const files = await fsPromises.readdir(dirPath, { withFileTypes: true });

        for (const file of files) {
          const fullPath = path.join(dirPath, file.name);

          if (file.isDirectory()) {
            await cleanupDir(fullPath);
          } else {
            const stats = await fsPromises.stat(fullPath);
            
            if (stats.mtime.getTime() < cutoffDate) {
              await fsPromises.unlink(fullPath);
              deletedCount++;
              deletedSize += stats.size;
              console.log(`🗑️  Deleted old recording: ${file.name}`);
            }
          }
        }
      };

      const callsDir = path.join(this.baseDir, 'calls');
      if (fs.existsSync(callsDir)) {
        await cleanupDir(callsDir);
      }

      console.log(`✅ Cleanup complete: ${deletedCount} files, ${formatSize(deletedSize)}`);

      return {
        success: true,
        deletedCount,
        deletedSize,
        message: `Deleted ${deletedCount} recordings older than ${daysOld} days`,
      };
    } catch (error) {
      console.error('❌ Cleanup failed:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get recording file path with security validation
   */
  getRecordingPath({ userId, agentId, fileName }) {
    // Security: Prevent directory traversal
    if (fileName && (fileName.includes('..') || fileName.includes('/'))) {
      throw new Error('Invalid file name');
    }
    return path.join(this.baseDir, 'calls', userId.toString(), agentId.toString(), fileName);
  }

  /**
   * Validate and get safe file path
   * Used for route handlers to prevent directory traversal attacks
   */
  getValidatedPath(dirType, userId, agentId, fileName) {
    // Security: Prevent directory traversal in all parameters
    if (fileName && (fileName.includes('..') || fileName.includes('/') || fileName.includes('\\'))) {
      throw new Error('Invalid file name');
    }

    let basePath;
    if (dirType === 'calls') {
      basePath = path.join(this.baseDir, 'calls', userId.toString(), agentId.toString());
    } else if (dirType === 'transcripts') {
      basePath = path.join(this.baseDir, 'transcripts', userId.toString(), agentId.toString());
    } else if (dirType === 'logs') {
      basePath = path.join(this.baseDir, 'logs', userId.toString());
    } else {
      throw new Error('Invalid directory type');
    }

    const fullPath = fileName ? path.join(basePath, fileName) : basePath;

    // Ensure path is within storage directory
    if (!fullPath.startsWith(path.resolve(this.baseDir))) {
      throw new Error('Path traversal detected');
    }

    return fullPath;
  }

  /**
   * Check if storage space available
   */
  async checkDiskSpace(requiredBytes = 100 * 1024 * 1024) {
    try {
      const stats = await fsPromises.stat(this.baseDir);
      // Note: This is a simplified check. In production, use diskusage module
      console.log(`📊 Storage available at ${this.baseDir}`);
      return true;
    } catch (error) {
      console.error('❌ Disk space check failed:', error.message);
      return false;
    }
  }
}

// Helper function for formatting bytes
function formatSize(bytes) {
  const sizes = ['B', 'KB', 'MB', 'GB'];
  if (bytes === 0) return '0 B';
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return Math.round((bytes / Math.pow(1024, i)) * 100) / 100 + ' ' + sizes[i];
}

module.exports = new LocalStorageService();

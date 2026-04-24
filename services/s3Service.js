/**
 * AWS S3 Service for Call Recording & Storage
 * Upload call recordings, transcripts, and logs to S3
 */
const AWS = require('aws-sdk');
const fs = require('fs');
const path = require('path');

class S3Service {
  constructor() {
    this.s3 = null;
    this.bucketName = process.env.AWS_S3_BUCKET;
    this.region = process.env.AWS_REGION || 'us-east-1';
    this.accessKeyId = process.env.AWS_ACCESS_KEY_ID;
    this.secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
    
    if (this.accessKeyId && this.secretAccessKey) {
      this.initializeS3();
    }
  }

  initializeS3() {
    AWS.config.update({
      accessKeyId: this.accessKeyId,
      secretAccessKey: this.secretAccessKey,
      region: this.region,
    });
    this.s3 = new AWS.S3();
  }

  isConfigured() {
    return !!this.s3 && !!this.bucketName;
  }

  /**
   * Upload recording file to S3
   */
  async uploadRecording({ recordingBuffer, callSid, userId, agentId, mimeType = 'audio/mpeg' }) {
    if (!this.isConfigured()) {
      console.warn('⚠️ S3 not configured. Recording skipped.');
      return null;
    }

    try {
      const key = `recordings/${userId}/${agentId}/${callSid}-${Date.now()}.mp3`;
      
      const params = {
        Bucket: this.bucketName,
        Key: key,
        Body: recordingBuffer,
        ContentType: mimeType,
        Metadata: {
          callSid,
          userId: userId.toString(),
          agentId: agentId.toString(),
          timestamp: new Date().toISOString(),
        },
      };

      const result = await this.s3.upload(params).promise();
      console.log(`✅ Recording uploaded: ${result.Location}`);
      return {
        url: result.Location,
        key: result.Key,
        size: recordingBuffer.length,
        bucket: this.bucketName,
      };
    } catch (error) {
      console.error('❌ S3 upload failed:', error.message);
      throw error;
    }
  }

  /**
   * Upload transcript as JSON
   */
  async uploadTranscript({ transcript, callSid, userId, agentId }) {
    if (!this.isConfigured()) {
      console.warn('⚠️ S3 not configured. Transcript skipped.');
      return null;
    }

    try {
      const key = `transcripts/${userId}/${agentId}/${callSid}-transcript.json`;
      
      const params = {
        Bucket: this.bucketName,
        Key: key,
        Body: JSON.stringify(transcript, null, 2),
        ContentType: 'application/json',
        Metadata: {
          callSid,
          userId: userId.toString(),
          agentId: agentId.toString(),
          timestamp: new Date().toISOString(),
        },
      };

      const result = await this.s3.upload(params).promise();
      console.log(`✅ Transcript uploaded: ${result.Location}`);
      return {
        url: result.Location,
        key: result.Key,
      };
    } catch (error) {
      console.error('❌ S3 transcript upload failed:', error.message);
      throw error;
    }
  }

  /**
   * Download recording from S3
   */
  async downloadRecording({ key }) {
    if (!this.isConfigured()) {
      throw new Error('S3 not configured');
    }

    try {
      const params = {
        Bucket: this.bucketName,
        Key: key,
      };

      const data = await this.s3.getObject(params).promise();
      return data.Body;
    } catch (error) {
      console.error('❌ S3 download failed:', error.message);
      throw error;
    }
  }

  /**
   * Get presigned URL for download
   */
  getPresignedUrl({ key, expiresIn = 3600 }) {
    if (!this.isConfigured()) {
      return null;
    }

    try {
      const params = {
        Bucket: this.bucketName,
        Key: key,
        Expires: expiresIn,
      };

      return this.s3.getSignedUrl('getObject', params);
    } catch (error) {
      console.error('❌ Presigned URL generation failed:', error.message);
      return null;
    }
  }

  /**
   * List recordings for a user
   */
  async listRecordings({ userId, agentId, maxKeys = 100 }) {
    if (!this.isConfigured()) {
      return [];
    }

    try {
      const params = {
        Bucket: this.bucketName,
        Prefix: `recordings/${userId}/${agentId}/`,
        MaxKeys: maxKeys,
      };

      const data = await this.s3.listObjectsV2(params).promise();
      return data.Contents || [];
    } catch (error) {
      console.error('❌ S3 list failed:', error.message);
      return [];
    }
  }
}

module.exports = new S3Service();

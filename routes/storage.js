/**
 * Recording Storage Routes
 * Serve recordings from local VPS storage
 */
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const localStorageService = require('../services/localStorageService');
const { protect } = require('../middleware/auth');

/**
 * GET /api/recordings/:userId/:agentId/:fileName
 * Download a recording
 */
router.get('/:userId/:agentId/:fileName', protect, async (req, res, next) => {
  try {
    const { userId, agentId, fileName } = req.params;

    // Security: User can only download their own recordings
    if (req.user._id.toString() !== userId && !req.user.isAdmin) {
      return res.status(403).json({
        success: false,
        message: 'Unauthorized: Cannot access other users recordings',
      });
    }

    const filePath = localStorageService.getValidatedPath('calls', userId, agentId, fileName);

    // Check if file exists
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        success: false,
        message: 'Recording not found',
      });
    }

    // Stream file with proper headers
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Cache-Control', 'public, max-age=86400'); // 24 hours

    const fileStream = fs.createReadStream(filePath);
    fileStream.pipe(res);

    fileStream.on('error', (error) => {
      console.error('Stream error:', error);
      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          message: 'Error streaming recording',
        });
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/recordings/:userId/:agentId
 * List recordings for a user/agent
 */
router.get('/:userId/:agentId', protect, async (req, res, next) => {
  try {
    const { userId, agentId } = req.params;
    const { limit = 50 } = req.query;

    // Security: User can only list their own recordings
    if (req.user._id.toString() !== userId && !req.user.isAdmin) {
      return res.status(403).json({
        success: false,
        message: 'Unauthorized',
      });
    }

    const recordings = await localStorageService.listRecordings({
      userId,
      agentId,
      limit: parseInt(limit),
    });

    res.json({
      success: true,
      count: recordings.length,
      recordings,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/recordings/:userId/:agentId/:fileName
 * Delete a recording
 */
router.delete('/:userId/:agentId/:fileName', protect, async (req, res, next) => {
  try {
    const { userId, agentId, fileName } = req.params;

    // Security checks
    if (req.user._id.toString() !== userId && !req.user.isAdmin) {
      return res.status(403).json({
        success: false,
        message: 'Unauthorized',
      });
    }

    const result = await localStorageService.deleteRecording({
      userId,
      agentId,
      fileName,
    });

    if (result.success) {
      res.json({
        success: true,
        message: 'Recording deleted',
      });
    } else {
      res.status(404).json(result);
    }
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/storage/stats
 * Get storage statistics
 */
router.get('/admin/stats', protect, async (req, res, next) => {
  try {
    // Admin only
    if (!req.user.isAdmin) {
      return res.status(403).json({
        success: false,
        message: 'Admin only',
      });
    }

    const stats = await localStorageService.getStorageStats();
    res.json(stats);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/storage/cleanup
 * Cleanup old recordings
 */
router.post('/admin/cleanup', protect, async (req, res, next) => {
  try {
    // Admin only
    if (!req.user.isAdmin) {
      return res.status(403).json({
        success: false,
        message: 'Admin only',
      });
    }

    const { daysOld = 30 } = req.body;
    const result = await localStorageService.cleanupOldRecordings({ daysOld });

    res.json(result);
  } catch (error) {
    next(error);
  }
});

module.exports = router;

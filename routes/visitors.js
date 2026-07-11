const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const Visitor = require('../models/Visitor');
const { protect } = require('../middleware/auth');

// Setup Nodemailer Transporter
// If SMTP credentials aren't provided, we will just log the OTP for testing purposes
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: process.env.SMTP_PORT || 587,
  secure: process.env.SMTP_SECURE === 'true', // true for 465, false for other ports
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

const generateToken = (email) => {
  return jwt.sign({ type: 'visitor', email }, process.env.JWT_SECRET, {
    expiresIn: '24h',
  });
};

// @route   POST /api/visitors/send-otp
router.post('/send-otp', async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ success: false, message: 'Email is required' });
    }

    const otp = crypto.randomInt(100000, 999999).toString();
    const otpExpires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    let visitor = await Visitor.findOne({ email });
    if (!visitor) {
      visitor = new Visitor({ email });
    }
    visitor.otp = otp;
    visitor.otpExpires = otpExpires;
    await visitor.save();

    // Send email
    if (process.env.SMTP_USER && process.env.SMTP_PASS) {
      const fromName = process.env.SMTP_FROM_NAME || 'VaaniAI Platform';
      const fromEmail = process.env.SMTP_FROM || process.env.SMTP_USER;
      const htmlTemplate = `
      <div style="font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 24px rgba(0,0,0,0.06); border: 1px solid #f1f5f9;">
        <div style="background: linear-gradient(135deg, #7c3aed 0%, #06b6d4 100%); padding: 40px 32px; text-align: center;">
          <h1 style="color: #ffffff; margin: 0; font-size: 28px; font-weight: 600; letter-spacing: -0.5px;">Vocred Agent Sandbox</h1>
          <p style="color: rgba(255,255,255,0.8); font-size: 16px; margin-top: 8px; margin-bottom: 0;">Your secure verification code</p>
        </div>
        
        <div style="padding: 48px 32px; text-align: center;">
          <p style="color: #475569; font-size: 16px; line-height: 24px; margin: 0 0 32px 0;">
            Use the following one-time password (OTP) to securely log in and test the Vocred voice AI agent.
          </p>
          
          <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 24px; display: inline-block; margin-bottom: 32px;">
            <span style="font-family: monospace; font-size: 36px; font-weight: 700; letter-spacing: 8px; color: #0f172a; margin-left: 8px;">${otp}</span>
          </div>
          
          <p style="color: #64748b; font-size: 14px; margin: 0;">
            This code will expire in <strong style="color: #0f172a;">10 minutes</strong>. If you did not request this code, you can safely ignore this email.
          </p>
        </div>
        
        <div style="background-color: #f8fafc; padding: 24px 32px; text-align: center; border-top: 1px solid #f1f5f9;">
          <p style="color: #94a3b8; font-size: 13px; margin: 0;">
            &copy; ${new Date().getFullYear()} Vocred. All rights reserved.
          </p>
        </div>
      </div>
      `;

      const mailOptions = {
        from: `"${fromName}" <${fromEmail}>`,
        to: email,
        subject: 'Your Vocred OTP Verification Code',
        text: `Your Vocred OTP is ${otp}. It will expire in 10 minutes.`,
        html: htmlTemplate,
      };
      await transporter.sendMail(mailOptions);
      console.log(`OTP sent to ${email}`);
    } else {
      console.log(`[TESTING] OTP for ${email} is ${otp}`);
    }

    res.json({ success: true, message: 'OTP sent successfully' });
  } catch (error) {
    console.error('Send OTP Error:', error);
    next(error);
  }
});

// @route   POST /api/visitors/verify-otp
router.post('/verify-otp', async (req, res, next) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) {
      return res.status(400).json({ success: false, message: 'Email and OTP are required' });
    }

    const visitor = await Visitor.findOne({ email });
    if (!visitor) {
      return res.status(404).json({ success: false, message: 'Visitor not found' });
    }

    if (visitor.otp !== otp || visitor.otpExpires < new Date()) {
      return res.status(400).json({ success: false, message: 'Invalid or expired OTP' });
    }

    visitor.isVerified = true;
    visitor.otp = undefined;
    visitor.otpExpires = undefined;
    await visitor.save();

    const token = generateToken(visitor.email);

    res.json({
      success: true,
      token,
      visitor: {
        email: visitor.email,
        isVerified: visitor.isVerified,
      },
    });
  } catch (error) {
    console.error('Verify OTP Error:', error);
    next(error);
  }
});

// @route   GET /api/visitors
// Protected route for Admins only
router.get('/', protect, async (req, res, next) => {
  try {
    const visitors = await Visitor.find({ isVerified: true }).sort({ createdAt: -1 });
    res.json({ success: true, visitors });
  } catch (error) {
    next(error);
  }
});

module.exports = router;

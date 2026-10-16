const mongoose = require('mongoose');

const reportSchema = new mongoose.Schema({
  empId: {
    type: String,
    required: true,
    trim: true,
    index: true
  },
  empName: {
    type: String,
    required: true,
    trim: true
  },
  organizationId: {
    type: String,
    default: 'org_advmen_platform',
    index: true
  },
  workCategory: {
    type: String,
    default: 'Development & Code Changes'
  },
  workReport: {
    type: String,
    required: true,
    trim: true
  },
  developmentChanges: {
    type: String,
    default: '',
    trim: true
  },
  taskSummary: {
    type: String,
    default: '',
    trim: true
  },
  attendanceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Attendance',
    default: null
  },
  date: {
    type: String,
    default: null
  },
  punchInTime: {
    type: String,
    default: null
  },
  punchOutTime: {
    type: String,
    default: null
  },
  workMode: {
    type: String,
    default: 'Office'
  },
  location: {
    address: { type: String, default: '' },
    lat: { type: Number, default: null },
    lng: { type: Number, default: null },
    accuracy: { type: Number, default: null },
    isHome: { type: Boolean, default: false }
  },
  status: {
    type: String,
    default: 'Submitted'
  },
  submittedAt: {
    type: Date,
    default: Date.now
  },
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  }
}, {
  collection: 'reports',
  timestamps: true
});

reportSchema.index({ empId: 1, createdAt: -1 });
reportSchema.index({ organizationId: 1, createdAt: -1 });

module.exports = mongoose.model('Report', reportSchema);

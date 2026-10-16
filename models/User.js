const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  empId: { type: String, unique: true, required: true },
  name: { type: String, required: true, trim: true },
  email: { type: String, unique: true, required: true, lowercase: true, trim: true },
  normalizedEmail: { type: String, lowercase: true, trim: true },
  organizationId: { type: String, default: 'org_advmen_platform' },
  password: { type: String, required: true },
  role: { type: String, default: 'EMPLOYEE' },
  createdAt: { type: Date, default: Date.now }
});

// Pre-save hook: ensure normalizedEmail and organizationId are always non-null
userSchema.pre('save', function (next) {
  if (this.email && !this.normalizedEmail) {
    this.normalizedEmail = this.email.toLowerCase().trim();
  }
  if (!this.organizationId) {
    this.organizationId = 'org_advmen_platform';
  }
  next();
});

module.exports = mongoose.model('User', userSchema);
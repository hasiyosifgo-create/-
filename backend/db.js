import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const botStateSchema = new mongoose.Schema({
  id: { type: String, default: 'bot_state', unique: true },
  balance: { type: Number, default: 500000 },
  initialBalance: { type: Number, default: 500000 },
  portfolio: { type: mongoose.Schema.Types.Mixed, default: {} },
  history: { type: Array, default: [] },
  parameters: { type: mongoose.Schema.Types.Mixed, default: {} },
  logs: { type: Array, default: [] },
  learningReport: { type: String, default: '' },
  lastReviewDate: { type: String, default: '' },
  assetHistory: { type: Array, default: [] }
});

export const BotState = mongoose.model('BotState', botStateSchema);

export const connectDB = async () => {
  try {
    const uri = process.env.MONGODB_URI;
    if (!uri) {
      console.warn("MONGODB_URI is not set. Data will not be saved to MongoDB. Please check your .env or Render Environment Variables.");
      return false;
    }
    await mongoose.connect(uri);
    console.log("Connected to MongoDB successfully");
    return true;
  } catch (error) {
    console.error("MongoDB connection error:", error);
    return false;
  }
};

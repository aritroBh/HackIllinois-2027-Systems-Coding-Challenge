import mongoose, { Schema, Document } from 'mongoose';

export enum IdempotencyStatus {
  PENDING = 'PENDING',
  COMMITTED = 'COMMITTED',
  FAILED = 'FAILED',
}

export interface IIdempotencyRecord extends Document {
  key: string;
  userId: string;
  endpoint: string;
  requestHash: string;
  status: IdempotencyStatus;
  responseStatusCode?: number;
  responseBody?: unknown;
  createdAt: Date;
  updatedAt: Date;
}

const IdempotencySchema = new Schema<IIdempotencyRecord>(
  {
    key: { type: String, required: true, unique: true, index: true },
    userId: { type: String, required: true },
    endpoint: { type: String, required: true },
    requestHash: { type: String, required: true },
    status: {
      type: String,
      enum: Object.values(IdempotencyStatus),
      required: true,
      default: IdempotencyStatus.PENDING,
    },
    responseStatusCode: { type: Number },
    responseBody: { type: Schema.Types.Mixed },
  },
  { timestamps: true }
);

// Auto-purge records after 24 hours (86400 seconds)
IdempotencySchema.index({ createdAt: 1 }, { expireAfterSeconds: 86400 });

export const IdempotencyRecord = mongoose.model<IIdempotencyRecord>('IdempotencyRecord', IdempotencySchema);

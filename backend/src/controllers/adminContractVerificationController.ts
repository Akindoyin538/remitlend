import type { Request, Response } from 'express';
import { contractVerificationService } from '../services/contractVerificationService.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const getContractVerificationStatus = asyncHandler(
  async (_req: Request, res: Response) => {
    const [stats, contracts] = await Promise.all([
      contractVerificationService.getVerificationStats(),
      contractVerificationService.getAllVerificationStatuses(),
    ]);

    res.json({ ...stats, contracts });
  },
);

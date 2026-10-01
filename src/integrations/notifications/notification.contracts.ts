/**
 * OTP delivery contracts.
 *
 * The canonical contract lives in `src/application/auth/ports.ts` so the
 * application layer has no dependency on this directory. Re-exported here for
 * convenience and for adapter authors.
 */

export type {
  OtpDeliveryChannel as OtpDeliveryChannel,
  OtpDeliveryProvider as OtpDeliveryProvider,
  OtpDeliveryRequest as OtpDeliveryRequest,
  OtpDeliveryResult as OtpDeliveryResult,
} from '../../application/auth/ports.js';
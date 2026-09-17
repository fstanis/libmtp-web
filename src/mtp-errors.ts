abstract class NamedError extends Error {
  /** PTP response code (e.g. 0x2009) when the device reported one; absent for transport-level failures. */
  readonly code?: number;

  constructor(message: string, code?: number) {
    super(message);
    this.name = new.target.name;
    if (code !== undefined) {
      this.code = code;
    }
  }
}

export class MtpDeviceNotFoundError extends NamedError {}
export class MtpOpenError extends NamedError {}
export class MtpFileReadError extends NamedError {}
export class MtpWriteError extends NamedError {}
export class MtpSessionClosedError extends NamedError {}
/** The device was unplugged mid-session; permanent until a new requestMtpFileSystem(). */
export class MtpDeviceDisconnectedError extends NamedError {}
/** The device reports the object handle is gone (deleted on-device, PTP 0x2009); permanent, do not retry. */
export class MtpObjectNotFoundError extends NamedError {}

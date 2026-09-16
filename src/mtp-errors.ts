abstract class NamedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class MtpDeviceNotFoundError extends NamedError {}
export class MtpOpenError extends NamedError {}
export class MtpFileReadError extends NamedError {}
export class MtpWriteError extends NamedError {}
export class MtpSessionClosedError extends NamedError {}

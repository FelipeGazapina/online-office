import type { OfficeApi } from '../../shared/protocol.ts';

declare global {
  interface Window {
    office: OfficeApi;
  }
}

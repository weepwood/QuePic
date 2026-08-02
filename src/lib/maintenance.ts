export interface MaintenanceState {
  active: boolean;
  message: string;
}

const DEFAULT_STATE: MaintenanceState = {
  active: false,
  message: '',
};

let currentState = DEFAULT_STATE;
const listeners = new Set<(state: MaintenanceState) => void>();

export class MaintenanceBlockedError extends Error {
  constructor(message = 'QuePic 正在执行备份维护，当前操作已暂停。') {
    super(message);
    this.name = 'MaintenanceBlockedError';
  }
}

export function getMaintenanceState(): MaintenanceState {
  return currentState;
}

export function isMaintenanceActive(): boolean {
  return currentState.active;
}

export function setMaintenanceState(active: boolean, message = ''): void {
  currentState = active ? { active: true, message } : DEFAULT_STATE;
  for (const listener of listeners) listener(currentState);
}

export function subscribeMaintenance(listener: (state: MaintenanceState) => void): () => void {
  listeners.add(listener);
  listener(currentState);
  return () => listeners.delete(listener);
}

export function assertOperationAllowed(): void {
  if (currentState.active) {
    throw new MaintenanceBlockedError(currentState.message || undefined);
  }
}

export function isMaintenanceBlockedError(error: unknown): error is MaintenanceBlockedError {
  return error instanceof MaintenanceBlockedError;
}

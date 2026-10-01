import { installStopHandlers } from '../../src/commands/execution-control';

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

describe('installStopHandlers (SIGINT, SIGTERM, SIGHUP : story 4.4)', () => {
  beforeEach(() => {
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });
  afterEach(() => jest.restoreAllMocks());

  it.each(SIGNALS)('%s : arrêt demandé sans sortir ; second signal : verrou libéré puis sortie 130', (signal) => {
    const order: string[] = [];
    const exit = jest.spyOn(process, 'exit').mockImplementation(((code: number) => void order.push(`exit ${code}`)) as never);
    const stop = installStopHandlers('du média', () => order.push('verrou libéré'));
    expect(stop.stopRequested()).toBe(false);
    process.emit(signal);
    expect(stop.stopRequested()).toBe(true);
    expect(exit).not.toHaveBeenCalled();
    process.emit(signal);
    expect(order).toEqual(['verrou libéré', 'exit 130']);
    stop.dispose();
  });

  it('un signal différent compte comme le second (Ctrl-C puis kill)', () => {
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const stop = installStopHandlers('du média', () => undefined);
    process.emit('SIGHUP');
    process.emit('SIGTERM');
    expect(exit).toHaveBeenCalledWith(130);
    stop.dispose();
  });

  it('dispose retire les trois gestionnaires', () => {
    const before = SIGNALS.map((signal) => process.listenerCount(signal));
    const stop = installStopHandlers('de la ligne', () => undefined);
    expect(SIGNALS.map((signal) => process.listenerCount(signal))).toEqual(before.map((n) => n + 1));
    stop.dispose();
    expect(SIGNALS.map((signal) => process.listenerCount(signal))).toEqual(before);
  });
});

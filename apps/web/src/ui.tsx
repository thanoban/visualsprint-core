import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { errorMessage } from "./api.js";

type Data<T> = { value?: T; error?: unknown; loading: boolean };
export function useData<T>(
  load: (signal: AbortSignal) => Promise<T>,
  dependencies: unknown[],
): Data<T> {
  const scope = useMemo(() => Symbol("request-scope"), dependencies);
  const [data, setData] = useState<Data<T> & { scope: symbol }>({ loading: true, scope });
  useEffect(() => {
    const controller = new AbortController();
    setData({ loading: true, scope });
    void load(controller.signal).then(
      (value) => {
        if (!controller.signal.aborted) setData({ value, loading: false, scope });
      },
      (error) => {
        if (!controller.signal.aborted) setData({ error, loading: false, scope });
      },
    );
    return () => controller.abort();
  }, dependencies);
  return data.scope === scope ? data : { loading: true };
}
export function Feedback({ data }: { data: Data<unknown> }) {
  if (data.loading) return <p role="status">Loading…</p>;
  if (data.error)
    return (
      <p className="error" role="alert">
        {errorMessage(data.error)}
      </p>
    );
  return null;
}
// The key survives an uncertain network response. A changed payload is a new command.
export function useCommand() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const attempt = useRef<{ payload: string; key: string } | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function run<T>(
    payload: unknown,
    work: (key: string) => Promise<T>,
    done: (result: T) => void,
  ) {
    if (busy) return;
    const encoded = JSON.stringify(payload);
    if (!attempt.current || attempt.current.payload !== encoded)
      attempt.current = { payload: encoded, key: crypto.randomUUID() };
    setBusy(true);
    setError(undefined);
    try {
      const result = await work(attempt.current.key);
      attempt.current = null;
      if (mounted.current) done(result);
    } catch (cause) {
      if (mounted.current) setError(cause);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  return { busy, error, run };
}
export function Form({
  title,
  button,
  children,
  command,
  submit,
  disabled = false,
}: {
  title: string;
  button: string;
  children: ReactNode;
  command: ReturnType<typeof useCommand>;
  submit: () => void;
  disabled?: boolean;
}) {
  return (
    <form
      className="panel"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        submit();
      }}
    >
      <h3>{title}</h3>
      <fieldset disabled={command.busy || disabled}>
        {children}
        <button type="submit">{command.busy ? "Saving…" : button}</button>
      </fieldset>
      {command.error ? (
        <p role="alert" className="error">
          {errorMessage(command.error)}
        </p>
      ) : null}
    </form>
  );
}

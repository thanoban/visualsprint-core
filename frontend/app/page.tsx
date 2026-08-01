import Link from "next/link";

export default function HomePage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">VisualSprint</h1>
        <p className="mt-2 text-slate-600 max-w-2xl">
          Multilingual (Sinhala / Tamil / English) meeting intelligence. Upload a recording
          to generate an evidence-grounded report, or ask your org-memory chat a question
          across all past meetings.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Link
          href="/upload"
          className="rounded-lg border border-slate-200 bg-white p-5 hover:border-brand-500 hover:shadow-sm transition"
        >
          <h2 className="font-medium text-slate-900">Upload a meeting</h2>
          <p className="mt-1 text-sm text-slate-600">
            Submit an audio/video recording and watch it move through the capture pipeline.
          </p>
        </Link>
        <Link
          href="/chat"
          className="rounded-lg border border-slate-200 bg-white p-5 hover:border-brand-500 hover:shadow-sm transition"
        >
          <h2 className="font-medium text-slate-900">Ask org memory</h2>
          <p className="mt-1 text-sm text-slate-600">
            Chat across your organization&apos;s meeting history with cited evidence.
          </p>
        </Link>
      </div>
    </div>
  );
}

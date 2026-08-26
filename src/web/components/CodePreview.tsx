import { useEffect, useState } from 'react';
import { highlightCode, languageFromPath } from '../lib/highlight';

export function CodePreview({ code, filePath }: { code: string; filePath: string }) {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setHtml(null);
    setError('');

    highlightCode(code, filePath)
      .then((out) => {
        if (!cancelled) setHtml(out);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : '高亮失敗');
        }
      });

    return () => {
      cancelled = true;
    };
  }, [code, filePath]);

  if (error) {
    return (
      <pre className="text-xs font-mono whitespace-pre-wrap break-words leading-relaxed p-3">
        {code}
      </pre>
    );
  }

  if (!html) {
    return <div className="text-sm text-muted-foreground p-3">高亮中…</div>;
  }

  return (
    <div className="file-code-preview relative">
      <div className="absolute top-2 right-2 z-10 text-[10px] uppercase tracking-wide text-muted-foreground bg-background/80 border border-border rounded px-1.5 py-0.5">
        {languageFromPath(filePath)}
      </div>
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

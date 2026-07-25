import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function AssistMarkdown({ children, className = '' }: { children: string; className?: string }) {
  return (
    <div className={`assist-markdown ${className}`.trim()}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ node: _node, children: label, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer noopener">
              {label}
            </a>
          ),
          img: ({ alt }) => <span className="markdown-image-label">{alt || 'image'}</span>
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

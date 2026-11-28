import * as React from 'react';
import { ChevronRight, FileText, Folder, FolderOpen, FolderTree, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/i18n';
import { salesMatchExcerpt, salesTitle, type SalesKnowledge } from '@/lib/knowledge-sales';
import { cn } from '@/lib/utils';
import { knowledgeCategories, type KnowledgeCategory } from '@/types/knowledge';

const folderOrder = Object.keys(knowledgeCategories) as KnowledgeCategory[];

function folderOf(item: SalesKnowledge) {
  const category = item.revision.category;
  return category && Object.hasOwn(knowledgeCategories, category) ? category : 'product';
}

function Highlighted({ text, query }: { text: string; query: string }) {
  const terms = [...new Set(query.trim().split(/\s+/).filter(Boolean))];
  if (!terms.length || !text) return <>{text}</>;
  const pattern = new RegExp(
    '(' + terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')',
    'gi',
  );
  return (
    <>
      {text.split(pattern).map((part, index) =>
        terms.some((term) => part.toLocaleLowerCase() === term.toLocaleLowerCase()) ? (
          <mark
            key={index}
            className="rounded-sm bg-amber-200/80 px-0.5 text-foreground dark:bg-amber-400/30"
          >
            {part}
          </mark>
        ) : (
          <React.Fragment key={index}>{part}</React.Fragment>
        ),
      )}
    </>
  );
}

function DocumentRow({ item, current, query, onChoose }: {
  item: SalesKnowledge;
  current: boolean;
  query: string;
  onChoose: (item: SalesKnowledge) => void;
}) {
  const title = salesTitle(item.revision.title);
  const excerpt = query.trim() ? salesMatchExcerpt(item, query) : '';
  return (
    <li>
      <button
        type="button"
        aria-current={current || undefined}
        data-user-content
        onClick={() => onChoose(item)}
        title={title}
        className={cn(
          'flex min-h-11 w-full items-baseline gap-2 rounded-md px-2 py-2 text-left text-xs transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
          current ? 'bg-accent font-semibold text-accent-foreground' : 'text-foreground hover:bg-muted/70',
        )}
      >
        <FileText className="relative top-0.5 h-3.5 w-3.5 shrink-0 self-start text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block break-words leading-5"><Highlighted text={title} query={query} /></span>
          {excerpt && (
            <span className="mt-0.5 line-clamp-2 break-words text-[11px] font-normal leading-relaxed text-muted-foreground">
              <Highlighted text={excerpt} query={query} />
            </span>
          )}
        </span>
        <span className="shrink-0 font-mono text-[10px] font-normal tabular-nums text-muted-foreground">
          v{item.revision.version}
        </span>
      </button>
    </li>
  );
}

export function KnowledgeDirectory({ matches, total, selected, query, onSearch, onChoose }: {
  matches: SalesKnowledge[];
  total: number;
  selected?: SalesKnowledge;
  query: string;
  onSearch: (value: string) => void;
  onChoose: (item: SalesKnowledge) => void;
}) {
  const { t } = useI18n();
  const id = React.useId();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [openFolders, setOpenFolders] = React.useState<KnowledgeCategory[]>(() => selected ? [folderOf(selected)] : []);
  const [closedResults, setClosedResults] = React.useState<KnowledgeCategory[]>([]);
  const searching = Boolean(query.trim());

  function search(value: string) {
    setClosedResults([]);
    onSearch(value);
  }

  function toggleFolder(folder: KnowledgeCategory) {
    const update = searching ? setClosedResults : setOpenFolders;
    update((folders) => folders.includes(folder) ? folders.filter((f) => f !== folder) : [...folders, folder]);
  }

  function choose(item: SalesKnowledge) {
    if (searching) {
      const folder = folderOf(item);
      setOpenFolders((folders) => folders.includes(folder) ? folders : [...folders, folder]);
    }
    onChoose(item);
  }

  return (
    <>
      <div className="shrink-0 space-y-2.5 border-b border-border/80 p-3.5">
        <div className="flex items-center justify-between gap-2">
          <h2 id={id} className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
            <FolderTree className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
            {t('knowledge.directory.title')}
          </h2>
          <span role="status" className="text-[11px] tabular-nums text-muted-foreground">
            {searching
              ? t('knowledge.directory.resultCount', { count: matches.length, total })
              : t('knowledge.directory.count', { count: total })}
          </span>
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" aria-hidden />
          <Input
            ref={inputRef}
            id="sales-knowledge-query"
            type="search"
            aria-label={t('knowledge.directory.search')}
            className="h-9 bg-card pl-8 text-xs"
            value={query}
            placeholder={t('knowledge.directory.placeholder')}
            onChange={(e) => search(e.target.value)}
          />
        </div>
      </div>

      {matches.length ? (
        <nav aria-labelledby={id} className="min-h-0 flex-1 overflow-y-auto p-2">
          <ul className="space-y-0.5">
            {folderOrder.map((folder) => {
              const items = matches.filter((item) => folderOf(item) === folder);
              if (!items.length) return null;
              const expanded = searching ? !closedResults.includes(folder) : openFolders.includes(folder);
              const Icon = expanded ? FolderOpen : Folder;
              const groupId = id + '-' + folder;
              return (
                <li key={folder}>
                  <button
                    type="button"
                    aria-expanded={expanded}
                    aria-controls={groupId}
                    onClick={() => toggleFolder(folder)}
                    className="flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] font-semibold text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  >
                    <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground motion-safe:transition-transform', expanded && 'rotate-90')} aria-hidden />
                    <Icon className="h-4 w-4 shrink-0 fill-gold-soft text-gold" aria-hidden />
                    <span className="min-w-0 flex-1 break-words">{t(`knowledge.directory.category.${folder}`)}</span>
                    <span className="min-w-5 rounded bg-muted px-1 text-center font-mono text-[11px] font-normal tabular-nums text-muted-foreground">
                      {items.length}
                    </span>
                  </button>
                  <ul id={groupId} hidden={!expanded} className="mb-1 ml-[15px] space-y-0.5 border-l border-border pl-2">
                    {expanded && items.map((item) => (
                      <DocumentRow key={item.id} item={item} current={item.id === selected?.id} query={query} onChoose={choose} />
                    ))}
                  </ul>
                </li>
              );
            })}
          </ul>
        </nav>
      ) : (
        <div className="p-6 text-center text-xs">
          <p className="font-medium text-foreground">{t('knowledge.directory.empty')}</p>
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => {
              search('');
              inputRef.current?.focus();
            }}
          >
            {t('knowledge.directory.clear')}
          </Button>
        </div>
      )}
    </>
  );
}

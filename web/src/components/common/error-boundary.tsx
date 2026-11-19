import * as React from 'react';
import { AlertTriangle, Home, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface ErrorBoundaryState {
  hasError: boolean;
  message: string;
  isChunkError: boolean;
}

export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, message: '', isChunkError: false };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    const message = error instanceof Error ? error.message : String(error ?? '未知渲染错误');
    const isChunkError = /loading chunk|dynamically imported module|failed to fetch dynamically/i.test(message);
    return { hasError: true, message, isChunkError };
  }

  componentDidCatch(error: unknown): void {
    if (import.meta.env.DEV) {
      console.error('[ErrorBoundary]', error);
    }
  }

  private handleReload = (): void => {
    if (this.state.isChunkError) {
      window.location.reload();
      return;
    }
    this.setState({ hasError: false, message: '', isChunkError: false });
  };

  private handleGoHome = (): void => {
    this.setState({ hasError: false, message: '', isChunkError: false });
    window.location.assign('/');
  };

  render(): React.ReactNode {
    if (!this.state.hasError) return this.props.children;
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-6">
        <div className="w-full max-w-md space-y-4 rounded-xl border bg-card p-6 text-center shadow-sm">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
            <AlertTriangle className="h-6 w-6" aria-hidden />
          </div>
          <div className="space-y-1.5">
            <h1 className="text-base font-semibold text-foreground">
              {this.state.isChunkError ? '应用已更新，请刷新页面' : '页面渲染遇到异常'}
            </h1>
            <p className="text-xs leading-5 text-muted-foreground">
              {this.state.isChunkError
                ? '检测到前端静态资源版本变化，刷新后即可恢复正常。'
                : '当前页面发生意外错误，业务数据未受影响。您可以重试或返回首页。'}
            </p>
          </div>
          <div className="flex justify-center gap-2 pt-1">
            <Button type="button" variant="outline" size="sm" onClick={this.handleGoHome}>
              <Home className="h-3.5 w-3.5" aria-hidden />
              返回首页
            </Button>
            <Button type="button" size="sm" onClick={this.handleReload}>
              <RefreshCw className="h-3.5 w-3.5" aria-hidden />
              {this.state.isChunkError ? '刷新页面' : '重试加载'}
            </Button>
          </div>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;

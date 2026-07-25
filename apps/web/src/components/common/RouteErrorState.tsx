import { CircleAlert, Home, RefreshCw } from 'lucide-react';
import { isRouteErrorResponse, useNavigate, useRouteError } from 'react-router-dom';

export function RouteErrorState() {
  const error = useRouteError();
  const navigate = useNavigate();
  const detail = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText || '路由错误'}`
    : error instanceof Error
      ? error.message
      : '页面渲染过程中发生未知错误';

  return (
    <main className="route-error-state" role="alert">
      <span className="route-error-icon">
        <CircleAlert size={22} />
      </span>
      <span className="overline">页面不可用</span>
      <h1>当前页面暂时无法显示</h1>
      <p>{detail}</p>
      <div>
        <button className="button secondary" onClick={() => window.location.reload()}>
          <RefreshCw size={15} />
          刷新页面
        </button>
        <button className="button primary" onClick={() => navigate('/projects')}>
          <Home size={15} />
          返回项目
        </button>
      </div>
    </main>
  );
}

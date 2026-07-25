import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useSetup } from '../api/queries';
import { FullPageState } from '../components/common/FullPageState';

export function RequireSetup() {
  const setup = useSetup();
  const location = useLocation();
  if (setup.isLoading) return <FullPageState title="正在检查工作空间" />;
  if (setup.isError)
    return <FullPageState title="无法连接本地服务" detail={setup.error.message} retry={setup.refetch} />;
  if (!setup.data?.complete) return <Navigate to="/setup" state={{ from: location.pathname }} replace />;
  return <Outlet />;
}

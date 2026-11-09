import type { ICustomsSource } from '../../models/Customs';

export interface CustomsProviderTestResult {
  ok: boolean;
  message: string;
}

export interface CustomsProviderAdapter {
  key: string;
  test(source: Pick<ICustomsSource, 'kind' | 'provider'>): Promise<CustomsProviderTestResult>;
}

const csvAdapter: CustomsProviderAdapter = {
  key: 'csv',
  async test() {
    return { ok: true, message: 'CSV 数据源可接收导入' };
  },
};

const apiAdapter: CustomsProviderAdapter = {
  key: 'api',
  async test() {
    return { ok: false, message: 'API 供应商 Adapter 尚未配置，请先完成供应商接入' };
  },
};

/** 供应商边界保持在一个入口，业务层不直接依赖某家供应商。 */
export function resolveCustomsProviderAdapter(source: Pick<ICustomsSource, 'kind'>): CustomsProviderAdapter {
  return source.kind === 'csv' ? csvAdapter : apiAdapter;
}

import React from 'react';
import ReactDOM from 'react-dom/client';
import { ConfigProvider, App as AntdApp } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import App from './App';
import './styles/global.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider locale={zhCN} theme={{
      token: {
        colorPrimary: '#16213e',
        borderRadius: 6,
      },
    }}>
      <AntdApp>
        <App />
      </AntdApp>
    </ConfigProvider>
  </React.StrictMode>,
);

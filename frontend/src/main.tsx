import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ExperimentalPiApp } from "./experimental/pi/ExperimentalPiApp";
import { experimentalPiUiEnabled } from "./experimental/pi/config";
import "@fontsource-variable/inter";
import "./styles/global.css";

const rootApplication = experimentalPiUiEnabled() ? <ExperimentalPiApp /> : <App />;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {rootApplication}
  </React.StrictMode>
);

#!/usr/bin/env node
import { App } from "aws-cdk-lib";
import { PlatformStack } from "./stack.js";

const app = new App();
const stage = String(app.node.tryGetContext("stage") ?? "dev");
new PlatformStack(app, `WhatsappAgentsPlatform-${stage}`, { stage });

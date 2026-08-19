import { describe, expect, test } from "bun:test";
import { classifyDomain, domainInterfaceId } from "../src/knowledge/domains.ts";

describe("domain classification", () => {
  test("classifies retrieval and agent concepts", () => {
    expect(classifyDomain(["pi agent websearch 方法调研"])).toBe("检索");
    expect(classifyDomain(["sls 日志按 traceId 定位未回复原因"])).toBe("日志诊断");
    expect(classifyDomain(["用 dms 查用户表字段与时间列"])).toBe("数据查询");
    expect(classifyDomain(["opencode 子代理配置与模型档位"])).toBe("agent-runtime");
    expect(classifyDomain(["完全无关的一句话"])).toBeNull();
  });

  test("domain interface id is stable", () => {
    expect(domainInterfaceId("检索")).toBe(domainInterfaceId("检索"));
    expect(domainInterfaceId("检索")).not.toBe(domainInterfaceId("日志诊断"));
  });
});

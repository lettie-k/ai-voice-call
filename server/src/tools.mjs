// 电话里它能用的工具（可选）。默认一个都不给——先把电话打顺。
//
// 想加就在 tools 里写 Anthropic 工具定义，在 runTool 里接实现。比如开空调、查天气、发消息。
// 我们自己是挂了一堆 MCP 服务器（家电、小红书、记忆……）；经验：
//   · 电话里工具表要有预算（坑 #17）——挂太多，工具说明 + 人格涨到二十万 token，每句都答不上；
//   · 调工具前先说一句短的再动手，回来一两句口语说结果（brain.mjs 的 CALL_HINT 里写了）；
//   · 工具在途时用户插话先攒着、别掐（坑 #14，call.mjs 里做了）。

export const tools = [
  // 示例：
  // {
  //   name: 'get_weather',
  //   description: '查某个城市现在的天气',
  //   input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  // },
];

export async function runTool(name, input) {
  switch (name) {
    // case 'get_weather': return `${input.city} 晴，22 度`;
    default:
      throw new Error(`没有这个工具：${name}`);
  }
}

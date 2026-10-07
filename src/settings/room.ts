export const defaultReserverSign = 'RESERVED BY E9C50, PLEASE STAY AWAY ⚠️⚠️⚠️'
export const roomSignTextList = [
  "总有一天总有一年你会发现，有人默默陪在你的身边。", // 《等你下课》
  "路过的爱情都太年轻，你是我想要再回去的风景。", // 《手写的从前》
  "翻着我们的照片想念若隐若现，去年的冬天我们笑得很甜。", // 《借口》
  "没有你在我有多难熬，没有你烦我有多烦恼。", // 《开不了口》
  "也许爱在梦的另一端，无法存活在真实的空间。", // 《回到过去》
  "城堡为爱守着秘密，而我为你守着回忆！", // 《明明就》
  "斑驳的城门盘踞着老树根，石板上回荡的是再等。", // 《烟花易冷》
  "寒风经过院子里的枝芽，也冷却了我手中的鲜花。", // 《心雨》
  "铜镜映无邪，扎马尾，你若撒野，今生我把酒奉陪。", // 《发如雪》
  "那已风化千年的誓言，一切又重演。", // 《爱在西元前》
  "如果你要走，请你记得我。如果你难过，请你忘了我。", // 《借口》
  "已经习惯不去阻止你，过好一阵子你就会回来。", // 《半岛铁盒》
  "我用漂亮的押韵，形容被掠夺一空的爱情。", // 《夜曲》
  "你要离开我知道很简单，你说依赖是我们的阻碍。", // 《彩虹》
  "你是我唯一想要的了解。", // 《七里香》
  "也许时间是一种解药，也是我现在所服下的毒药。", // 《彩虹》
  "请不要把分手当作你的请求，我知道坚持要走是你受伤的借口。", // 《借口》
  "而我已经分不清，你是友情，还是错过的爱情。", // 《蒲公英的约定》
  "唱反调是我的本性，出其不意是我的个性。", // 《红模仿》
  "过往的欢乐是否褪色，想问你怎么舍得。", // 《你比从前快乐》
  "你说不该再相见只为了瞬间，谢谢你让我听见，因为我在等待永远。", // 《白色风车》
  "从前有个人爱你很久，但偏偏风渐渐把距离吹得好远。", // 《晴天》
  "天青色等烟雨，而我在等你。", // 《青花瓷》
  "炊烟袅袅升起，隔江千万里。", // 《青花瓷》
  "海鸟跟鱼相爱，只是一场意外。", // 《珊瑚海》
  "我知道我们都没有错，只是放手会比较好过。", // 《退后》
  "我会发着呆，然后忘记你，接着紧紧闭上眼，想着那一天会有人代替，让我不再想念你。", // 《轨迹》
  "最美的不是下雨天，而是与你一起躲过雨的屋檐。", // 《不能说的秘密》
  "这世界谁被狩猎，谁淌血，我却只为拯救你的无邪。", // 《夜的第七章》
  "听妈妈的话，别让她受伤，想快快长大才能保护她。" // 《听妈妈的话》
];

/** Legacy compatibility only; automatic stock targets are defined in settings/resourcePolicy.ts. */
export const defaultAutoResource = {
    [RESOURCE_CATALYZED_LEMERGIUM_ACID]: 20000,     // +100% repair 和 build 效率但不增加其能量消耗
    [RESOURCE_LEMERGIUM_ACID]: 10000,               // +80% repair 和 build 效率但不增加其能量消耗
    [RESOURCE_LEMERGIUM_HYDRIDE]: 10000,            // +50% repair 和 build 效率但不增加其能量消耗

    [RESOURCE_CATALYZED_GHODIUM_ACID]: 20000,       // +100% upgradeController 效率但不增加其能量消耗
    [RESOURCE_GHODIUM_ACID]: 10000,                 // +80% upgradeController 效率但不增加其能量消耗
    [RESOURCE_GHODIUM_HYDRIDE]: 10000,              // +50% upgradeController 效率但不增加其能量消耗

    [RESOURCE_CATALYZED_ZYNTHIUM_ALKALIDE]: 20000,  // +300% fatigue(疲劳值) 减低速度
    [RESOURCE_ZYNTHIUM_ALKALIDE]: 10000,            // +200% fatigue(疲劳值) 减低速度
    [RESOURCE_ZYNTHIUM_OXIDE]: 10000,               // +100% fatigue(疲劳值) 减低速度

    [RESOURCE_CATALYZED_ZYNTHIUM_ACID]: 20000,      // +300% dismantle 效率
    [RESOURCE_ZYNTHIUM_ACID]: 10000,                // +200% dismantle 效率
    [RESOURCE_ZYNTHIUM_HYDRIDE]: 10000,             // +100% dismantle 效率

    [RESOURCE_CATALYZED_GHODIUM_ALKALIDE]: 20000,   // 70% 伤害减免
    [RESOURCE_GHODIUM_ALKALIDE]: 10000,             // 50% 伤害减免
    [RESOURCE_GHODIUM_OXIDE]: 10000,                // 30% 伤害减免

    [RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE]: 20000, // +300% heal and rangedHeal 效率
    [RESOURCE_LEMERGIUM_ALKALIDE]: 10000,           // +200% heal 和 rangedHeal 效率
    [RESOURCE_LEMERGIUM_OXIDE]: 10000,              // +100% heal 和 rangedHeal 效率

    [RESOURCE_CATALYZED_KEANIUM_ALKALIDE]: 20000,   // +300% rangedAttack 和 rangedMassAttack 效率
    [RESOURCE_KEANIUM_ALKALIDE]: 10000,             // +200% rangedAttack 和 rangedMassAttack 效率
    [RESOURCE_KEANIUM_OXIDE]: 10000,                // +100% rangedAttack 和 rangedMassAttack 效率

    [RESOURCE_CATALYZED_KEANIUM_ACID]: 20000,       // +150 容量
    [RESOURCE_KEANIUM_ACID]: 10000,                 // +100 容量
    [RESOURCE_KEANIUM_HYDRIDE]: 10000,              // +50 容量

    [RESOURCE_CATALYZED_UTRIUM_ACID]: 20000,        // +300% attack 效率
    [RESOURCE_UTRIUM_ACID]: 10000,                  // +200% attack 效率
    [RESOURCE_UTRIUM_HYDRIDE]: 10000,               // +100% attack 效率

    [RESOURCE_CATALYZED_UTRIUM_ALKALIDE]: 20000,    // +600% harvest 效率
    [RESOURCE_UTRIUM_ALKALIDE]: 10000,              // +400% harvest 效率
    [RESOURCE_UTRIUM_OXIDE]: 10000,                 // +200% harvest 效率

    [RESOURCE_POWER]: 3000,
    [RESOURCE_OPS]: 3000,

    [RESOURCE_GHODIUM]: 10000,
    [RESOURCE_HYDROXIDE]: 10000,
    [RESOURCE_ZYNTHIUM_KEANITE]: 10000,
    [RESOURCE_UTRIUM_LEMERGITE]: 10000,

    [RESOURCE_CATALYST]: 10000,
    [RESOURCE_LEMERGIUM]: 10000,
    [RESOURCE_ZYNTHIUM]: 10000,
    [RESOURCE_KEANIUM]: 10000,
    [RESOURCE_UTRIUM]: 10000,
    [RESOURCE_OXYGEN]: 10000,
    [RESOURCE_HYDROGEN]: 10000,
}

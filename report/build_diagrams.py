from PIL import Image, ImageDraw, ImageFont
from pathlib import Path

S = 2
PAPER = (255, 249, 254)
INK = (27, 24, 20)
PURPLE = (98, 68, 142)
PURPLE_DARK = (57, 43, 98)
LILAC = (203, 184, 238)
PINK = (255, 90, 138)
YELLOW = (255, 216, 90)
MINT = (187, 241, 230)
CORAL = (255, 200, 184)
MUTED = (108, 94, 124)
WHITE = (255, 255, 255)
GRID = (238, 227, 245)

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "diagrams"
OUT.mkdir(parents=True, exist_ok=True)

FONT_BOLD = r"C:\Windows\Fonts\msyhbd.ttc"
FONT_REG = r"C:\Windows\Fonts\msyh.ttc"
FONT_MONO = r"C:\Windows\Fonts\consola.ttf"


def px(value):
    return int(value * S)


def get_font(size, bold=True, mono=False):
    if mono:
        return ImageFont.truetype(FONT_MONO, px(size))
    return ImageFont.truetype(FONT_BOLD if bold else FONT_REG, px(size))


def draw_text(draw, x, y, value, size=24, color=INK, bold=True, anchor="la", mono=False):
    draw.text((px(x), px(y)), value, font=get_font(size, bold, mono), fill=color, anchor=anchor)


def rounded(draw, x, y, w, h, fill, outline=INK, width=2, radius=24, shadow=True):
    if shadow:
        draw.rounded_rectangle(
            [px(x + 5), px(y + 6), px(x + w + 5), px(y + h + 6)],
            radius=px(radius),
            fill=(223, 205, 235),
        )
    draw.rounded_rectangle(
        [px(x), px(y), px(x + w), px(y + h)],
        radius=px(radius),
        fill=fill,
        outline=outline,
        width=px(width),
    )


def arrow(draw, x1, y1, x2, y2, color=PURPLE, width=3, both=False):
    draw.line([(px(x1), px(y1)), (px(x2), px(y2))], fill=color, width=px(width))
    # Horizontal arrows only, pointing right.
    size = 11
    draw.polygon(
        [
            (px(x2), px(y2)),
            (px(x2 - size), px(y2 - size / 2)),
            (px(x2 - size), px(y2 + size / 2)),
        ],
        fill=color,
    )
    if both:
        draw.polygon(
            [
                (px(x1), px(y1)),
                (px(x1 + size), px(y1 - size / 2)),
                (px(x1 + size), px(y1 + size / 2)),
            ],
            fill=color,
        )


def background(w, h, title, subtitle):
    image = Image.new("RGB", (px(w), px(h)), PAPER)
    draw = ImageDraw.Draw(image)
    for x in range(0, w, 28):
        for y in range(0, h, 28):
            draw.ellipse(
                [px(x), px(y), px(x + 1.7), px(y + 1.7)],
                fill=(243, 232, 249),
            )
    draw.rectangle([0, 0, px(w), px(10)], fill=PURPLE)
    draw.rectangle([0, px(h - 8), px(w), px(h)], fill=YELLOW)
    draw_text(draw, 70, 46, "MEME VAULT  /  WEEK 01", 18, PINK, True)
    draw_text(draw, 70, 82, title, 46, INK, True)
    draw_text(draw, 72, 143, subtitle, 20, MUTED, False)
    return image, draw


def architecture():
    w, h = 1600, 900
    image, draw = background(w, h, "系统架构", "浏览器原生 SPA  →  Node.js 22 单进程  →  SQLite + 本地文件")

    # Client
    rounded(draw, 70, 235, 360, 470, WHITE)
    draw.rounded_rectangle(
        [px(70), px(235), px(430), px(315)],
        radius=px(24),
        fill=YELLOW,
        outline=INK,
        width=px(2),
    )
    draw_text(draw, 96, 255, "浏览器客户端", 28, INK)
    draw_text(draw, 96, 290, "HTML + CSS + Vanilla JS", 16, MUTED, False)
    items = ["登录 / 注册", "单张上传", "搜索 / 分类", "审核工作台", "受保护下载"]
    for index, item in enumerate(items):
        y = 342 + index * 66
        draw.rounded_rectangle(
            [px(96), px(y), px(404), px(y + 48)],
            radius=px(12),
            fill=(255, 246, 253),
            outline=LILAC,
            width=px(1.5),
        )
        draw.ellipse([px(112), px(y + 17), px(126), px(y + 31)], fill=PINK)
        draw_text(draw, 142, y + 11, item, 20, INK, False)

    # Server
    rounded(draw, 600, 190, 520, 560, WHITE)
    draw.rounded_rectangle(
        [px(600), px(190), px(1120), px(274)],
        radius=px(24),
        fill=PURPLE,
        outline=INK,
        width=px(2),
    )
    draw_text(draw, 628, 211, "Node.js 22 服务", 30, WHITE)
    draw_text(draw, 630, 247, "零第三方依赖 · 单进程", 16, (238, 225, 248), False)
    modules = [
        ("静态资源服务", "CSP、缓存头、路径校验"),
        ("认证 / 会话", "scrypt、SHA-256、HttpOnly"),
        ("表情 API", "列表、分类、搜索、分页"),
        ("审核与权限", "user / reviewer / admin"),
        ("图片校验", "文件头、尺寸、5 MB 上限"),
    ]
    for index, (name, desc) in enumerate(modules):
        y = 302 + index * 77
        draw.rounded_rectangle(
            [px(625), px(y), px(1095), px(y + 58)],
            radius=px(13),
            fill=(248, 239, 255),
            outline=LILAC,
            width=px(1.5),
        )
        draw_text(draw, 646, y + 10, name, 19, PURPLE_DARK)
        draw_text(draw, 646, y + 35, desc, 15, MUTED, False)
    draw_text(draw, 627, 704, "同源校验 · 安全响应头 · 登录限流", 16, PINK, True)

    # Data
    rounded(draw, 1210, 238, 310, 300, WHITE)
    draw.rounded_rectangle(
        [px(1210), px(238), px(1520), px(310)],
        radius=px(24),
        fill=MINT,
        outline=INK,
        width=px(2),
    )
    draw_text(draw, 1236, 257, "SQLite", 28, INK)
    draw_text(draw, 1236, 291, "data/meme-vault.db", 15, MUTED, False)
    for index, table in enumerate(["users", "sessions", "emojis"]):
        y = 332 + index * 57
        draw.rounded_rectangle(
            [px(1240), px(y), px(1490), px(y + 38)],
            radius=px(9),
            fill=WHITE,
            outline=INK,
            width=px(1.3),
        )
        draw_text(draw, 1260, y + 8, table, 18, PURPLE_DARK, mono=True)
    draw_text(draw, 1240, 516, "3 张表 · 4 个索引 · WAL", 15, MUTED, False)

    rounded(draw, 1210, 570, 310, 185, WHITE)
    draw.rounded_rectangle(
        [px(1210), px(570), px(1520), px(642)],
        radius=px(24),
        fill=CORAL,
        outline=INK,
        width=px(2),
    )
    draw_text(draw, 1236, 590, "uploads/", 27, INK)
    draw_text(draw, 1236, 623, "UUID 原图 · 非静态目录", 15, MUTED, False)
    draw_text(draw, 1240, 671, "仅通过鉴权接口读取", 16, INK, False)
    draw_text(draw, 1240, 703, "删除时同步清理文件", 16, INK, False)

    # Transport labels
    arrow(draw, 438, 420, 590, 420, PURPLE, 4, both=True)
    draw_text(draw, 447, 382, "HTTPS", 15, PURPLE, True)
    draw_text(draw, 447, 441, "JSON / Cookie", 14, MUTED, False)
    arrow(draw, 1128, 420, 1200, 420, PURPLE, 4, both=True)
    draw_text(draw, 1132, 384, "SQL / FS", 14, PURPLE, True)

    # Deployment strip
    draw.rounded_rectangle(
        [px(70), px(770), px(1520), px(838)],
        radius=px(18),
        fill=PURPLE_DARK,
        outline=INK,
        width=px(2),
    )
    draw_text(draw, 99, 790, "部署链路", 17, YELLOW)
    draw_text(
        draw,
        210,
        787,
        "Nginx / Caddy（TLS）  →  Node :3000  →  data/ + uploads/ 持久化卷",
        22,
        WHITE,
        False,
    )
    image.resize((w, h), Image.Resampling.LANCZOS).save(OUT / "architecture.png")
    print("architecture.png")


def entity(draw, x, y, w, h, name, note, fields, color):
    rounded(draw, x, y, w, h, WHITE, radius=18)
    draw.rounded_rectangle(
        [px(x), px(y), px(x + w), px(y + 78)],
        radius=px(18),
        fill=color,
        outline=INK,
        width=px(2),
    )
    draw_text(draw, x + 22, y + 16, name, 26, INK)
    draw_text(draw, x + 22, y + 50, note, 14, MUTED, False)
    for index, field in enumerate(fields):
        row_y = y + 96 + index * 29
        if index < len(fields) - 1:
            draw.line(
                [(px(x + 14), px(row_y + 23)), (px(x + w - 14), px(row_y + 23))],
                fill=(240, 232, 247),
                width=px(1),
            )
        draw_text(draw, x + 22, row_y, field[0], 16, INK, False, mono=True)
        if field[1]:
            label, badge_color = field[1]
            badge_w = 60 if label == "PK" else 58
            bx = x + w - badge_w - 20
            draw.rounded_rectangle(
                [px(bx), px(row_y + 1), px(bx + badge_w), px(row_y + 21)],
                radius=px(6),
                fill=badge_color,
                outline=None,
                width=0,
            )
            draw_text(draw, bx + badge_w / 2, row_y + 4, label, 11, INK, True, anchor="ma")


def er_diagram():
    w, h = 1600, 980
    image, draw = background(w, h, "数据库设计", "三张核心表：用户、会话、表情；文件元数据入库，原图落盘")

    # Lines first, behind cards.
    draw.line([(px(500), px(340)), (px(670), px(340)), (px(670), px(390)), (px(800), px(390))], fill=PURPLE, width=px(3))
    draw_text(draw, 520, 306, "1 : N", 16, PINK, True)
    draw_text(draw, 548, 350, "上传", 14, MUTED, False)

    draw.line([(px(500), px(420)), (px(640), px(420)), (px(640), px(555)), (px(800), px(555))], fill=PURPLE, width=px(3))
    draw_text(draw, 520, 432, "1 : N", 16, PINK, True)
    draw_text(draw, 548, 464, "审核", 14, MUTED, False)

    draw.line([(px(300), px(560)), (px(300), px(705))], fill=PURPLE, width=px(3))
    draw_text(draw, 315, 618, "1 : N", 16, PINK, True)

    entity(
        draw,
        70,
        240,
        430,
        320,
        "users",
        "账号与角色",
        [
            ("id", ("PK", YELLOW)),
            ("username", ("UK", MINT)),
            ("password_hash", None),
            ("role", None),
            ("created_at", None),
        ],
        YELLOW,
    )
    draw_text(draw, 92, 524, "role：user / reviewer / admin", 13, MUTED, False)

    entity(
        draw,
        70,
        705,
        430,
        205,
        "sessions",
        "服务端会话",
        [
            ("token_hash", ("PK", YELLOW)),
            ("user_id", ("FK", LILAC)),
            ("created_at", None),
            ("expires_at", ("IDX", MINT)),
        ],
        MINT,
    )

    entity(
        draw,
        800,
        220,
        730,
        690,
        "emojis",
        "表情元数据与审核状态",
        [
            ("id", ("PK", YELLOW)),
            ("owner_id", ("FK", LILAC)),
            ("title", None),
            ("category", None),
            ("stored_name", ("UK", MINT)),
            ("original_name", None),
            ("mime_type", None),
            ("size_bytes", None),
            ("width / height", None),
            ("status", None),
            ("review_note", None),
            ("reviewed_by", ("FK", LILAC)),
            ("reviewed_at", None),
            ("download_count", None),
            ("created_at", None),
        ],
        LILAC,
    )
    draw_text(
        draw,
        824,
        836,
        "status：pending / approved / rejected",
        13,
        MUTED,
        False,
    )
    draw_text(
        draw,
        824,
        868,
        "索引：status+created · owner+created · category",
        13,
        MUTED,
        False,
    )

    # Legend / notes
    draw.rounded_rectangle(
        [px(70), px(640), px(500), px(680)],
        radius=px(9),
        fill=(255, 246, 253),
        outline=LILAC,
        width=px(1.3),
    )
    draw_text(draw, 84, 650, "删用户 → 级联删除其会话与表情", 13, MUTED, False)
    draw_text(draw, 84, 671, "删审核人 → reviewed_by 置空", 13, MUTED, False)
    image.resize((w, h), Image.Resampling.LANCZOS).save(OUT / "er.png")
    print("er.png")


architecture()
er_diagram()

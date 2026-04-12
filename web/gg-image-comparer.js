import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

function imageDataToUrl(data) {
    return api.apiURL(`/view?filename=${encodeURIComponent(data.filename)}&type=${data.type}&subfolder=${data.subfolder || ""}${app.getPreviewFormatParam()}${app.getRandParam()}`);
}

class GGImageComparerWidget {
    constructor(name, node) {
        this.name = name;
        this.node = node;
        this._value = { images: [] };
        this.selected = [];
    }

    set value(v) {
        const cleanedVal = v.images || [];
        let selected = cleanedVal.filter(d => d.selected);
        if (!selected.length && cleanedVal.length) {
            cleanedVal[0].selected = true;
        }
        selected = cleanedVal.filter(d => d.selected);
        if (selected.length === 1 && cleanedVal.length > 1) {
            cleanedVal.find(d => !d.selected).selected = true;
        }
        this._value.images = cleanedVal;
        this.setSelected(selected);
    }

    get value() {
        return this._value;
    }

    setSelected(selected) {
        this._value.images.forEach(d => d.selected = false);
        this.node.imgs.length = 0;
        for (const sel of selected) {
            if (!sel.img) {
                sel.img = new Image();
                sel.img.src = sel.url;
                this.node.imgs.push(sel.img);
            }
            sel.selected = true;
        }
        this.selected = selected;
    }

    draw(ctx, node, width, y) {
        if (!this.selected[0]?.img || !this.selected[0].img.naturalWidth) {
            ctx.save();
            ctx.fillStyle = "#555";
            ctx.font = "italic 14px sans-serif";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText("Connect images to compare", width / 2, y + 40);
            ctx.restore();
            return;
        }

        const img = this.selected[0].img;
        const imageH = width * (img.naturalHeight / img.naturalWidth);

        if (node.isPointerOver && node.pointerOverPos) {
            const mouseX = node.pointerOverPos[0];
            ctx.drawImage(img, 0, y, width, imageH);
            ctx.save();
            ctx.beginPath();
            ctx.rect(0, y, mouseX, imageH);
            ctx.clip();
            if (this.selected[1]?.img) {
                ctx.drawImage(this.selected[1].img, 0, y, width, imageH);
            }
            ctx.restore();

            ctx.save();
            ctx.globalCompositeOperation = "difference";
            ctx.strokeStyle = "rgba(255,255,255,1)";
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(mouseX, y);
            ctx.lineTo(mouseX, y + imageH);
            ctx.stroke();
            ctx.globalCompositeOperation = "source-over";
            ctx.restore();
        } else {
            if (this.selected[1]?.img) {
                ctx.drawImage(this.selected[1].img, 0, y, width, imageH);
            } else {
                ctx.drawImage(img, 0, y, width, imageH);
            }
        }

        ctx.save();
        ctx.fillStyle = "rgba(0,0,0,0.5)";
        ctx.font = "bold 12px system-ui, sans-serif";
        ctx.textBaseline = "top";
        if (node.isPointerOver && node.pointerOverPos) {
            ctx.textAlign = "left";
            ctx.fillText("A", 6, y + 4);
            ctx.textAlign = "right";
            ctx.fillText("B", width - 6, y + 4);
        }
        ctx.restore();
    }

    computeSize(width) {
        const img = this.selected[0]?.img;
        if (img && img.complete && img.naturalWidth > 0) {
            const aspect = img.naturalHeight / img.naturalWidth;
            return [width, width * aspect + 20];
        }
        return [width, 100];
    }

    onMouseDown(e, node, canvas) {
        return false;
    }

    serializeValue(node, index) {
        return this._value;
    }
}

app.registerExtension({
    name: "ComfyUI.GGNodes.ImageComparer",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name === "GGImageComparer4" || nodeData.name === "GGImageComparer8") {
            nodeType.prototype.onNodeCreated = function() {
                this._labels = [];
                this.size[1] = 580;

                this.onExecuted = function(output) {
                    if (output.ui?.labels) {
                        this._labels = output.ui.labels;
                        setTimeout(() => app.graph.setDirtyCanvas(true, true), 50);
                    }
                };

                const origDraw = this.onDrawBackground;
                this.onDrawBackground = function(ctx) {
                    origDraw?.call(this, ctx);
                    if (!this._labels || this._labels.length === 0) return;

                    const [w, h] = this.size;
                    const num = this._labels.length;
                    const subW = w / num;

                    ctx.save();
                    ctx.font = "bold 17px system-ui, -apple-system, sans-serif";
                    ctx.textAlign = "center";
                    ctx.textBaseline = "middle";

                    for (let i = 0; i < num; i++) {
                        const x = subW * i + subW / 2;
                        const label = this._labels[i] || `图像 ${i+1}`;
                        ctx.fillStyle = "rgba(0,0,0,0.75)";
                        const textWidth = ctx.measureText(label).width;
                        ctx.fillRect(x - textWidth/2 - 10, h - 48, textWidth + 20, 32);
                        ctx.fillStyle = "#ffffff";
                        ctx.fillText(label, x, h - 32);
                    }
                    ctx.restore();
                };
            };
        }
    },

    });

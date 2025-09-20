import React, { useState } from "react";
import {
  Button,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Box,
  Typography,
} from "@mui/material";
import { Palette, ColorLens } from "@mui/icons-material";

interface ColorPickerProps {
  selectedColor: string;
  onColorChange: (color: string) => void;
  label?: string;
}

export const ColorPicker: React.FC<ColorPickerProps> = ({
  selectedColor,
  onColorChange,
  label = "Color",
}) => {
  const [open, setOpen] = useState(false);
  const [customColor, setCustomColor] = useState("#000000");

  const handleCustomColorChange = (color: string) => {
    setCustomColor(color);
    onColorChange(color); // Automatically apply the custom color
  };

  const handleOpenDialog = () => {
    setCustomColor(selectedColor);
    setOpen(true);
  };

  return (
    <>
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1,
          cursor: "pointer",
          padding: 1,
          borderRadius: 1,
          border: "2px solid transparent",
          "&:hover": {
            border: "2px solid #1976d2",
            backgroundColor: "rgba(25, 118, 210, 0.04)",
          },
          transition: "all 0.2s ease-in-out",
        }}
        onClick={handleOpenDialog}
      >
        <Box
          sx={{
            width: 32,
            height: 32,
            borderRadius: "50%",
            backgroundColor: selectedColor,
            border: "2px solid #fff",
            boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            position: "relative",
            "&::after": {
              content: '""',
              position: "absolute",
              width: "100%",
              height: "100%",
              borderRadius: "50%",
              border: "1px solid rgba(0,0,0,0.1)",
            },
          }}
        >
          <ColorLens sx={{ fontSize: 16, color: "#fff", filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.3))" }} />
        </Box>
        <Typography variant="body2" sx={{ fontWeight: 500, color: "#666" }}>
          {label}
        </Typography>
      </Box>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        maxWidth="sm"
        fullWidth
        PaperProps={{
          sx: {
            borderRadius: 2,
            boxShadow: "0 8px 32px rgba(0,0,0,0.12)",
          },
        }}
      >
        <DialogTitle sx={{ pb: 1 }}>
          <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
            <Palette color="primary" />
            <Typography variant="h6">Choose Team Color</Typography>
          </Box>
        </DialogTitle>

        <DialogContent sx={{ pt: 2 }}>
          {/* Full Color Picker */}
          <Typography variant="subtitle2" sx={{ mb: 2, fontWeight: 600 }}>
            Select Color
          </Typography>
          <Box sx={{ display: "flex", alignItems: "center", gap: 2, mb: 3 }}>
            <input
              type="color"
              value={customColor}
              onChange={(e) => handleCustomColorChange(e.target.value)}
              style={{
                width: 80,
                height: 80,
                border: "none",
                borderRadius: "12px",
                cursor: "pointer",
                outline: "none",
                boxShadow: "0 4px 16px rgba(0,0,0,0.2)",
              }}
            />
            <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
              <Typography variant="h6" sx={{ fontWeight: 600 }}>
                {customColor.toUpperCase()}
              </Typography>
              <Typography variant="body2" sx={{ color: "#666" }}>
                Click the color square to open the full color picker
              </Typography>
            </Box>
          </Box>
        </DialogContent>

        <DialogActions sx={{ p: 2 }}>
          <Button onClick={() => setOpen(false)} color="inherit">
            Cancel
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
};
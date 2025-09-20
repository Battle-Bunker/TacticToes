
import React, { useRef, useState } from "react";
import {
  Box,
  Typography,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
} from "@mui/material";
import { ColorLens, Palette } from "@mui/icons-material";

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
  const [open, setOpen] = useState(true); // Start with dialog open
  const [tempColor, setTempColor] = useState(selectedColor);

  const handleOpenDialog = () => {
    setTempColor(selectedColor);
    setOpen(true);
  };

  const handleColorChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setTempColor(event.target.value);
  };

  const handleApply = () => {
    onColorChange(tempColor);
    setOpen(false);
  };

  const handleCancel = () => {
    setTempColor(selectedColor);
    setOpen(false);
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
        onClose={handleCancel}
        maxWidth="sm"
        fullWidth
        PaperProps={{
          sx: {
            borderRadius: 2,
            boxShadow: "0 8px 32px rgba(0,0,0,0.12)",
            border: "2px solid #000",
          },
        }}
      >
        <DialogTitle sx={{ pb: 1 }}>
          <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
            <Palette color="primary" />
            <Typography variant="h6">Choose Color</Typography>
          </Box>
        </DialogTitle>

        <DialogContent sx={{ pt: 2 }}>
          <Box sx={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
            <input
              type="color"
              value={tempColor}
              onChange={handleColorChange}
              style={{
                width: 120,
                height: 120,
                border: "none",
                borderRadius: "12px",
                cursor: "pointer",
                outline: "none",
                boxShadow: "0 4px 16px rgba(0,0,0,0.2)",
              }}
            />
            <Box sx={{ textAlign: "center" }}>
              <Typography variant="h6" sx={{ fontWeight: 600 }}>
                {tempColor.toUpperCase()}
              </Typography>
              <Typography variant="body2" sx={{ color: "#666" }}>
                Selected Color
              </Typography>
            </Box>
          </Box>
        </DialogContent>

        <DialogActions sx={{ p: 2, gap: 1 }}>
          <Button onClick={handleCancel} color="inherit">
            Cancel
          </Button>
          <Button onClick={handleApply} variant="contained" color="primary">
            Apply
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
};
